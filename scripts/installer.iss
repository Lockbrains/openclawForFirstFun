; =============================================
; FirstClaw Installer — Inno Setup 6 Script
; =============================================
;
; How to compile:
;   1. Open this file in Inno Setup 6
;   2. Menu: Build → Compile (or Ctrl+F9)
;   3. Output .exe goes to scripts\installer-output\
;
; What the installer does:
;   - Copies project files to the user's chosen directory
;   - Installs Node.js automatically (if missing)
;   - Installs pnpm automatically (if missing)
;   - Runs pnpm install to fetch dependencies
;   - Runs pnpm build to compile the project
;   - Creates desktop shortcuts
;
; =============================================

#define MyAppName "FirstClaw"
#define MyAppVersion "2026.2"
#define MyAppPublisher "FirstClaw Team"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=installer-output
OutputBaseFilename=FirstClaw-Setup-{#MyAppVersion}
; Use zip compression to avoid OOM during compilation (deps are fetched at install time anyway)
Compression=zip
SolidCompression=no
WizardStyle=modern
DisableDirPage=no
DisableProgramGroupPage=yes
ShowLanguageDialog=no
; Custom branding
SetupIconFile=installer-assets\setup-icon.ico
UninstallDisplayIcon={app}\scripts\installer-assets\setup-icon.ico
WizardImageFile=installer-assets\wizard-image.bmp
WizardSmallImageFile=installer-assets\wizard-small-image.bmp

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to {#MyAppName} Setup
WelcomeLabel2=This wizard will install {#MyAppName} on your computer.%n%nThe installer will automatically set up the required environment (Node.js, pnpm) and build the project.%n%nThis takes about 5-15 minutes depending on your network speed. Please ensure you are connected to the internet.%n%nClick Next to continue.

[Files]
; --- src/ (exclude test files — they are not needed for building) ---
Source: "..\src\*"; DestDir: "{app}\src"; \
  Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "*.test.ts,*.e2e.test.ts,*.test.js,*.spec.ts"

; --- extensions/ (exclude test files) ---
Source: "..\extensions\*"; DestDir: "{app}\extensions"; \
  Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "*.test.ts,*.e2e.test.ts,node_modules\*"

; --- ui/ (exclude node_modules and tests) ---
Source: "..\ui\*"; DestDir: "{app}\ui"; \
  Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "node_modules\*,*.test.ts,*.spec.ts"

; --- Other required directories (exclude node_modules — pnpm install recreates them) ---
Source: "..\packages\*"; DestDir: "{app}\packages"; \
  Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "node_modules\*"
Source: "..\patches\*"; DestDir: "{app}\patches"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\vendor\*"; DestDir: "{app}\vendor"; \
  Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; \
  Excludes: "node_modules\*"
Source: "..\assets\*"; DestDir: "{app}\assets"; \
  Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; \
  Excludes: "node_modules\*"

; --- scripts/ (runtime + build scripts, exclude heavy/dev-only subdirs & outputs) ---
Source: "..\scripts\*"; DestDir: "{app}\scripts"; \
  Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "docker\*,docs-i18n\*,e2e\*,repro\*,dev\*,shell-helpers\*,systemd\*,installer-output\*,*.py"
Source: "..\scripts\installer-assets\setup-icon.ico"; DestDir: "{app}\scripts\installer-assets"; Flags: ignoreversion

; --- docs/reference/templates/ (required by setup wizard for workspace init) ---
Source: "..\docs\reference\templates\*"; DestDir: "{app}\docs\reference\templates"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

; --- dist/ (pre-built output — fallback if pnpm build fails during bootstrap) ---
Source: "..\dist\*"; DestDir: "{app}\dist"; \
  Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "node_modules\*"

; --- Root config files (required for pnpm install + build) ---
Source: "..\.npmrc"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\pnpm-lock.yaml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\pnpm-workspace.yaml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tsconfig.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tsconfig.plugin-sdk.dts.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tsdown.config.ts"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\firstclaw.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{autodesktop}\FirstClaw Start"; \
  Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -NoExit -Command ""Set-Location '{app}'; Write-Host 'Starting FirstClaw Gateway ...' -ForegroundColor Cyan; node firstclaw.mjs gateway run --force"""; \
  WorkingDir: "{app}"; \
  Comment: "Start FirstClaw Gateway"; \
  IconFilename: "{app}\scripts\installer-assets\setup-icon.ico"

Name: "{autodesktop}\FirstClaw Setup"; \
  Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -NoExit -Command ""Set-Location '{app}'; node firstclaw.mjs setup"""; \
  WorkingDir: "{app}"; \
  Comment: "FirstClaw Setup Wizard"; \
  IconFilename: "{app}\scripts\installer-assets\setup-icon.ico"

Name: "{group}\FirstClaw Start"; \
  Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -NoExit -Command ""Set-Location '{app}'; node firstclaw.mjs gateway run --force"""; \
  WorkingDir: "{app}"

Name: "{group}\FirstClaw Setup"; \
  Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -NoExit -Command ""Set-Location '{app}'; node firstclaw.mjs setup"""; \
  WorkingDir: "{app}"

Name: "{group}\Uninstall FirstClaw"; \
  Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -Command ""$env:npm_config_manage_package_manager_versions='false'; & {{ Write-Host ''; Write-Host '========================================' -ForegroundColor Cyan; Write-Host '  FirstClaw environment setup in progress' -ForegroundColor Cyan; Write-Host '  Please do not close this window' -ForegroundColor Cyan; Write-Host '  Estimated time: 5-15 minutes' -ForegroundColor Cyan; Write-Host '========================================' -ForegroundColor Cyan; Write-Host ''; try {{ & '{app}\scripts\bootstrap.ps1' }} catch {{ Write-Host ''; Write-Host ('ERROR: ' + $_) -ForegroundColor Red; Write-Host ''; Write-Host 'Bootstrap failed. Pre-built dist/ is included, setup wizard may still work.' -ForegroundColor Yellow; Write-Host 'Press any key to continue ...' -ForegroundColor Yellow; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown'); return }}; Write-Host ''; Write-Host 'Setup complete! This window will close automatically.' -ForegroundColor Green; Start-Sleep -Seconds 3 }}"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Setting up environment (Node.js, pnpm, dependencies, build) ..."; \
  Flags: waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -NoExit -Command ""Set-Location '{app}'; Write-Host 'FirstClaw installed successfully! Please complete the initial configuration.' -ForegroundColor Green; Write-Host ''; node firstclaw.mjs setup"""; \
  WorkingDir: "{app}"; \
  Description: "Run setup wizard now (recommended)"; \
  Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\dist"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Setting up environment, please wait ...';
    { Write a .buildstamp AFTER all files are extracted so its mtime is newest.
      This prevents run-node.mjs from trying to rebuild the pre-packaged dist/. }
    SaveStringToFile(ExpandConstant('{app}\dist\.buildstamp'),
      GetDateTimeString('yyyymmddhhnnss', #0, #0) + #13#10, False);
  end;
end;
