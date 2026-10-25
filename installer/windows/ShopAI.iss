#define AppName "ShopAI"
#define AppVersion "1.0.0"
#define AppPublisher "ShopAI"

[Setup]
AppId={{B75ED54F-A83C-43D7-B8F5-35D6D8B578EF}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\ShopAI
DefaultGroupName={#AppName}
UninstallDisplayName={#AppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\..\dist\windows
OutputBaseFilename=ShopAI-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\..\backend\*"; DestDir: "{app}\backend"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "__pycache__\*;tests\*;storage\projects\*"
Source: "..\..\orchestrator\*"; DestDir: "{app}\orchestrator"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "__pycache__\*;tests\*"
Source: "..\..\frontend\dist\*"; DestDir: "{app}\frontend\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-backend.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "configure-llm.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "launch-shopai.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "stop-shopai.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion

[Icons]
Name: "{group}\ShopAI"; Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch-shopai.ps1"""
Name: "{group}\Configure LLM"; Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\configure-llm.ps1"""
Name: "{group}\Stop ShopAI"; Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\stop-shopai.ps1"""
Name: "{autodesktop}\ShopAI"; Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch-shopai.ps1"""; Tasks: desktopicon
Name: "{group}\Uninstall ShopAI"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install-backend.ps1"""; Description: "Install the ShopAI backend and Python dependencies"; StatusMsg: "Installing Python and ShopAI dependencies..."; Flags: runhidden waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\configure-llm.ps1"""; Description: "Configure the LLM provider"; Flags: waituntilterminated runasoriginaluser

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop-shopai.ps1"""; Flags: runhidden waituntilterminated
