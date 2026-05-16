' OpenClaw.vbs — Windows portable launcher shim
'
' Double-click this file to start OpenClaw without a black console
' window flashing. It locates Windows-Start.bat in the same directory
' and runs it in a normal cmd window so users still see logs.
'
' NOTE: associate OpenClaw.vbs with WScript (default on every Windows
' since XP) and give it a custom icon via a .lnk shortcut if you want
' OpenClaw branding. The .vbs itself uses the WScript icon by default.

Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")

' Resolve the directory containing this .vbs file
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "Windows-Start.bat")

If Not fso.FileExists(batPath) Then
    MsgBox "OpenClaw 启动失败：找不到 Windows-Start.bat" & vbCrLf & vbCrLf & _
           "请把 OpenClaw.vbs 与 Windows-Start.bat 放在同一目录。" & vbCrLf & vbCrLf & _
           "查找路径：" & vbCrLf & batPath, _
           vbCritical Or vbOKOnly, "OpenClaw"
    WScript.Quit 1
End If

' 1 = normal window, 0 = hidden, 7 = minimized.
' Use 1 so users can see the gateway logs and Ctrl+C to stop.
wsh.Run """" & batPath & """", 1, False
