param(
  [string] $PearLink = $env:PEARPASTE_LINK,
  [string] $OutputDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $PearLink -or -not $PearLink.StartsWith("pear://")) {
  throw "Set PEARPASTE_LINK or pass -PearLink pear://..."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$pearRuntimeExe = Join-Path $env:APPDATA "pear\current\by-arch\win32-x64\bin\pear-runtime.exe"
if (-not (Test-Path -LiteralPath $pearRuntimeExe)) { throw "Missing Pear runtime: $pearRuntimeExe" }

if (-not $OutputDir) {
  $OutputDir = Join-Path $root "dist\windows"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$payloadDir = Join-Path $OutputDir "PearPaste"
$launcherOut = Join-Path $OutputDir "launcher-publish"
$installerWork = Join-Path $OutputDir "installer-work"
$iexpressWork = "C:\tmp\pearpaste-iexpress"
$zipPath = Join-Path $OutputDir "PearPaste-win-x64.zip"
$setupPath = Join-Path $OutputDir "PearPaste-Setup.exe"

function Remove-GeneratedPath([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $resolved = [System.IO.Path]::GetFullPath($path)
  if (-not $resolved.StartsWith($OutputDir, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside output dir: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Remove-GeneratedPath $payloadDir
Remove-GeneratedPath $launcherOut
Remove-GeneratedPath $installerWork
if (Test-Path -LiteralPath $iexpressWork) { Remove-Item -LiteralPath $iexpressWork -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $setupPath) { Remove-Item -LiteralPath $setupPath -Force }

New-Item -ItemType Directory -Force -Path $payloadDir | Out-Null
Set-Content -LiteralPath (Join-Path $payloadDir "pearpaste.link") -Value $PearLink -NoNewline -Encoding ASCII

dotnet publish (Join-Path $root "scripts\windows-launcher\PearPasteLauncher.csproj") `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  -o $launcherOut
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath (Join-Path $launcherOut "PearPaste.exe") -Destination $payloadDir -Force

$selfTest = Start-Process `
  -FilePath (Join-Path $payloadDir "PearPaste.exe") `
  -ArgumentList @("--self-test") `
  -Wait `
  -PassThru
if ($selfTest.ExitCode -ne 0) { throw "PearPaste launcher self-test failed with exit code $($selfTest.ExitCode)" }

& $pearRuntimeExe help run | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Pear runtime smoke test failed with exit code $LASTEXITCODE" }

Compress-Archive -LiteralPath $payloadDir -DestinationPath $zipPath -CompressionLevel Optimal

New-Item -ItemType Directory -Force -Path $installerWork | Out-Null
New-Item -ItemType Directory -Force -Path $iexpressWork | Out-Null
Copy-Item -LiteralPath $zipPath -Destination (Join-Path $installerWork "payload.zip")
$installCmd = Join-Path $installerWork "install.cmd"
Set-Content -LiteralPath $installCmd -Encoding ASCII -Value @"
@echo off
setlocal
set APPDIR=%LOCALAPPDATA%\PearPaste
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path -LiteralPath `$env:LOCALAPPDATA\PearPaste) { Remove-Item -LiteralPath `$env:LOCALAPPDATA\PearPaste -Recurse -Force }; Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath `$env:LOCALAPPDATA -Force; `$shell = New-Object -ComObject WScript.Shell; `$desktop = [Environment]::GetFolderPath('Desktop'); `$shortcut = `$shell.CreateShortcut((Join-Path `$desktop 'PearPaste.lnk')); `$shortcut.TargetPath = Join-Path `$env:LOCALAPPDATA 'PearPaste\PearPaste.exe'; `$shortcut.WorkingDirectory = Join-Path `$env:LOCALAPPDATA 'PearPaste'; `$shortcut.IconLocation = `$shortcut.TargetPath; `$shortcut.Save(); `$programs = [Environment]::GetFolderPath('Programs'); `$menuDir = Join-Path `$programs 'PearPaste'; New-Item -ItemType Directory -Force -Path `$menuDir | Out-Null; `$menuShortcut = `$shell.CreateShortcut((Join-Path `$menuDir 'PearPaste.lnk')); `$menuShortcut.TargetPath = `$shortcut.TargetPath; `$menuShortcut.WorkingDirectory = `$shortcut.WorkingDirectory; `$menuShortcut.IconLocation = `$shortcut.TargetPath; `$menuShortcut.Save()"
if errorlevel 1 exit /b %errorlevel%
start "" "%APPDIR%\PearPaste.exe"
exit /b 0
"@

$iexpressInstallCmd = Join-Path $iexpressWork "install.cmd"
$iexpressPayload = Join-Path $iexpressWork "payload.zip"
Copy-Item -LiteralPath $installCmd -Destination $iexpressInstallCmd -Force
Copy-Item -LiteralPath (Join-Path $installerWork "payload.zip") -Destination $iexpressPayload -Force

$sedPath = Join-Path $iexpressWork "PearPaste-Setup.sed"
$iexpressSetupPath = Join-Path $iexpressWork "PearPaste-Setup.exe"
Set-Content -LiteralPath $sedPath -Encoding ASCII -Value @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=PearPaste has been installed.
TargetName=$iexpressSetupPath
FriendlyName=PearPaste
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=install.cmd
UserQuietInstCmd=install.cmd
FILE0=install.cmd
FILE1=payload.zip
[SourceFiles]
SourceFiles0=$iexpressWork
[SourceFiles0]
%FILE0%=
%FILE1%=
"@

$iexpress = Start-Process `
  -FilePath (Join-Path $env:WINDIR "System32\iexpress.exe") `
  -ArgumentList @("/N", "/Q", $sedPath) `
  -Wait `
  -PassThru
if ($iexpress.ExitCode -ne 0) { throw "IExpress failed with exit code $($iexpress.ExitCode)" }

$deadline = (Get-Date).AddMinutes(10)
while (-not (Test-Path -LiteralPath $iexpressSetupPath)) {
  if ((Get-Date) -gt $deadline) { throw "Installer was not created: $iexpressSetupPath" }
  Start-Sleep -Seconds 2
}

Copy-Item -LiteralPath $iexpressSetupPath -Destination $setupPath -Force

Get-Item -LiteralPath $setupPath, $zipPath, (Join-Path $payloadDir "PearPaste.exe") |
  Select-Object FullName, Length, LastWriteTime
