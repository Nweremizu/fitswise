; Start with Windows writes a value under Run. Remove it with the app, or Windows would try to start
; a program that is gone. The setting is per user, like the install.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FitsWise"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "FitsWise"
!macroend
