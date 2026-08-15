' Vek-Snap Silent Launcher
' Starts Electron with ZERO visible console window.
' This is the user-facing launcher: pin this to taskbar/desktop.

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolve paths relative to this script
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = fso.GetParentFolderName(scriptDir)
electronExe = appDir & "\node_modules\electron\dist\electron.exe"
shellDir = scriptDir

' Verify electron exists
If Not fso.FileExists(electronExe) Then
  MsgBox "Electron not found." & vbCrLf & vbCrLf & _
         "Expected: " & electronExe & vbCrLf & vbCrLf & _
         "Run: npm install", vbCritical, "Vek-Snap Launch Error"
  WScript.Quit 1
End If

' ── Mode selection ──
' Yes = Development, No = Production
result = MsgBox( _
  "Choose launch mode:" & vbCrLf & vbCrLf & _
  "  YES  =  Development  (HMR, ~1.8 GB RAM)" & vbCrLf & _
  "  NO   =  Production   (pre-built, ~250 MB RAM)" & vbCrLf & vbCrLf & _
  "Production requires a ~45s build step on first launch.", _
  vbYesNoCancel + vbQuestion, "Vek-Snap")

If result = vbCancel Then WScript.Quit 0

extraArgs = ""
If result = vbNo Then extraArgs = " --prod"

' Clear ELECTRON_RUN_AS_NODE (some editor/dev-tool terminals set this)
WshShell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"

' Launch Electron with normal window state.
' Electron itself uses show:false + ready-to-show to control visibility.
' Using 0 (vbHide) here would propagate SW_HIDE to the BrowserWindow,
' preventing it from ever appearing even after mainWindow.show().
' 1 = vbNormalFocus, False = don't wait for process to finish
WshShell.Run """" & electronExe & """ """ & shellDir & """" & extraArgs, 1, False
