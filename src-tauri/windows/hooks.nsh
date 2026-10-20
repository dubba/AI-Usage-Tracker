; Removes saved accounts, settings, and Windows sign-ins on a real uninstall.
; In-app updates pass /UPDATE to the installer and do not run the uninstaller.
; If this uninstaller is ever started with /UPDATE, $UpdateMode is 1 and the
; data stays. Defined outside the macros so ${__FILEDIR__} is this file's
; directory (inside a macro it would be the generated installer script).
!define AIUT_HOOK_DIR "${__FILEDIR__}"

!macro AIUT_RemoveBundleDir PARENT SUFFIX
  StrCpy $R8 "${PARENT}\com.dubba.ai.usage.tracker"
  IfFileExists "$R8\*.*" 0 AIUT_rm_done_${SUFFIX}
  ; FILE_ATTRIBUTE_REPARSE_POINT (0x400). A junction planted at the data
  ; folder is left alone so the fallback cannot delete through it.
  System::Call 'kernel32::GetFileAttributesW(w "$R8") i .r7'
  IntOp $6 $7 & 1024
  IntCmp $6 0 AIUT_rm_do_${SUFFIX} AIUT_rm_done_${SUFFIX} AIUT_rm_done_${SUFFIX}
  AIUT_rm_do_${SUFFIX}:
    RmDir /r "$R8"
  AIUT_rm_done_${SUFFIX}:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    InitPluginsDir
    File "/oname=$PLUGINSDIR\remove-windows-credentials.ps1" "${AIUT_HOOK_DIR}\remove-windows-credentials.ps1"
    File "/oname=$PLUGINSDIR\uninstall-rules.json" "${AIUT_HOOK_DIR}\uninstall-rules.json"
    nsExec::ExecToLog '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-windows-credentials.ps1"'
    Pop $0
    ${If} $0 = 2
      DetailPrint "Some saved sign-ins could not be removed from Windows Credential Manager."
    ${ElseIf} $0 <> 0
      DetailPrint "Could not finish removing saved sign-ins. Removing saved accounts and settings directly."
    ${EndIf}
    !insertmacro AIUT_RemoveBundleDir "$APPDATA" "Roaming"
    !insertmacro AIUT_RemoveBundleDir "$LOCALAPPDATA" "Local"
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
!macroend
