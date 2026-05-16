' OpenClaw.vbs - Windows portable launcher shim (v6)
' Forces a clean cmd window with echo off, so the user only sees
' the OpenClaw banner / status messages, not every batch command.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("Shell.Application")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath   = scriptDir & "\Windows-Start.bat"

If Not fso.FileExists(batPath) Then
    MsgBox "OpenClaw: Windows-Start.bat not found." & vbCrLf & "Looking for: " & batPath, 16, "OpenClaw"
    WScript.Quit 1
End If

' Use cmd.exe /c with explicit @echo off and /d-cd. This guarantees
' the launched window respects @echo off regardless of the user's
' AutoRun registry entries (which can re-enable echo and clobber
' Shell.Application.ShellExecute's default behavior).
'   /D = ignore HKCU\Software\Microsoft\Command Processor\AutoRun
'        which can be set by tools like git-bash or zoxide
'   /K = keep window open after the command finishes (so users see
'        any final error message before the window closes)
cmdArgs = "/D /K """ & batPath & """"

' ShellExecute(File, Args, WorkingDir, Verb, ShowFlag)
sh.ShellExecute "cmd.exe", cmdArgs, scriptDir, "open", 1
