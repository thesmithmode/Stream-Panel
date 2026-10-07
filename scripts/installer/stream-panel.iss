; Inno Setup script for Stream Panel Windows installer.
; Compiled by scripts/package-release.mjs on windows-latest (ISCC).
; AppVersion / OutputBaseFilename are overridden via /D defines from the packager.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "."
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef OutputBase
  #define OutputBase "StreamPanel-Setup"
#endif

[Setup]
AppId={{A7C3E1F0-8B2D-4E9A-9C1F-5D6E7F8091A2}
AppName=Stream Panel
AppVersion={#AppVersion}
AppPublisher=Stream Panel
AppPublisherURL=https://github.com/thesmithmode/Stream-Panel
DefaultDirName={autopf}\Stream Panel
DefaultGroupName=Stream Panel
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Stream Panel
SetupLogging=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Stream Panel"; Filename: "{app}\StreamPanel.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall Stream Panel"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Stream Panel"; Filename: "{app}\StreamPanel.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\StreamPanel.exe"; Description: "Launch Stream Panel"; Flags: nowait postinstall skipifsilent
