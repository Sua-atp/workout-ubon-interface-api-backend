Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "e:\web_Interface\Interface_api"
WshShell.Run "node src/server.js", 0, False
