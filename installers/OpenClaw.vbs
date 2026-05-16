' OpenClaw.vbs - Windows portable launcher shim (v5)
' Uses Shell.Application.ShellExecute instead of WScript.Shell.Run.
' ShellExecute is the same API used by Explorer double-click, so it
' works in every restricted environment that allows the user to
' double-click a .bat file at all.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("Shell.Application")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath   = scriptDir & "\Windows-Start.bat"

If Not fso.FileExists(batPath) Then
    MsgBox "OpenClaw: Windows-Start.bat not found." & vbCrLf & "Looking for: " & batPath, 16, "OpenClaw"
    WScript.Quit 1
End If

' ShellExecute(File, Args, WorkingDir, Verb, ShowFlag)
'   ShowFlag 1 = SW_SHOWNORMAL (normal cmd window so users see logs)
sh.ShellExecute batPath, "", scriptDir, "open", 1
