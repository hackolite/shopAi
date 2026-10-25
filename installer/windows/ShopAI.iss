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
Source: "..\..\assortment.json"; DestDir: "{app}"; Flags: ignoreversion
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

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop-shopai.ps1"""; Flags: runhidden waituntilterminated

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  CompletionMarker: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Installing Python and ShopAI dependencies...';
    WizardForm.Update;
    if not Exec(
      ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' +
        ExpandConstant('{app}\scripts\install-backend.ps1') + '"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    ) then
      RaiseException(
        'Could not start the ShopAI dependency installer. Check that Windows PowerShell is available.'
      );
    if ResultCode <> 0 then
      RaiseException(
        'ShopAI could not install its Python dependencies. See ' +
        ExpandConstant('{localappdata}\ShopAI\install-backend.log') +
        ' for details, then run the installer again.'
      );

    CompletionMarker := ExpandConstant('{localappdata}\ShopAI\install-complete');
    if not FileExists(CompletionMarker) then
      RaiseException(
        'ShopAI could not install its Python dependencies. See ' +
        ExpandConstant('{localappdata}\ShopAI\install-backend.log') +
        ' for details, then run the installer again.'
      );

    if not Exec(
      ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' +
        ExpandConstant('{app}\scripts\configure-llm.ps1') + '"',
      '',
      SW_SHOW,
      ewWaitUntilTerminated,
      ResultCode
    ) then
      RaiseException('Could not start the ShopAI LLM configuration window.');
  end;
end;
