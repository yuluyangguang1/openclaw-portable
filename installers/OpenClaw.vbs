' OpenClaw.vbs - Windows portable launcher shim
'
' Double-click this file to start OpenClaw. It locates
' Windows-Start.bat in the same directory and runs it in
' a normal cmd window so users still see the gateway logs.
'
' NOTE: this file is intentionally ASCII-only. Windows
' VBScript host (wscript.exe / cscript.exe) parses .vbs
' files using the system ANSI code page (e.g. CP936 on
' Simplified Chinese Windows), NOT UTF-8. Any non-ASCII
' bytes here would be interpreted as the local encoding
' and corrupt string/comment delimiters, producing the
' classic 800A0409 "Unterminated string constant" error.
' If you need to add localized text, use ChrW() escapes.

Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")

' Resolve the directory containing this .vbs file
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "Windows-Start.bat")

If Not fso.FileExists(batPath) Then
    ' Use ChrW() escapes to embed Chinese text safely. The
    ' literal Chinese characters cannot appear in the source
    ' or VBScript parsing breaks (see top-of-file comment).
    Dim msg
    msg = ChrW(&H542F) & ChrW(&H52A8) & ChrW(&H5931) & ChrW(&H8D25) & ": Windows-Start.bat not found." & vbCrLf & vbCrLf & _
          ChrW(&H8BF7) & ChrW(&H628A) & " OpenClaw.vbs " & ChrW(&H4E0E) & " Windows-Start.bat " & ChrW(&H653E) & ChrW(&H5728) & ChrW(&H540C) & ChrW(&H4E00) & ChrW(&H76EE) & ChrW(&H5F55) & "." & vbCrLf & vbCrLf & _
          "Looking for: " & batPath
    MsgBox msg, vbCritical Or vbOKOnly, "OpenClaw"
    WScript.Quit 1
End If

' 1 = normal window, 0 = hidden, 7 = minimized.
' Use 1 so users can see the gateway logs and Ctrl+C to stop.
wsh.Run """" & batPath & """", 1, False
