#define MyAppName "D-aquila Windows Edition"
#define MyAppPublisher "DASAN DATA"
#define MyAppExeName "D-aquila-Windows.exe"
#ifndef MyAppVersion
#define MyAppVersion "0.1.0"
#endif
#ifndef MySourceDir
#define MySourceDir "..\dist\D-aquila-Windows"
#endif

[Setup]
AppId={{D3C9AC61-1D6C-4F67-8F3A-DA001A001001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\D-aquila Windows Edition
DefaultGroupName=D-aquila
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=D-aquila-Windows-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면 아이콘 만들기"; GroupDescription: "추가 아이콘:"; Flags: unchecked

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\D-aquila Windows Edition"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall D-aquila Windows Edition"; Filename: "{uninstallexe}"
Name: "{autodesktop}\D-aquila Windows Edition"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "D-aquila Windows Edition 실행"; Flags: nowait postinstall skipifsilent
