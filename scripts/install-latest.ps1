[CmdletBinding()]
param(
  [string]$InstallerPath,
  [switch]$LaunchAfterInstall,
  [switch]$ForceCloseRunningApp
)

$ErrorActionPreference = "Stop"

$productName = "Amex Local Finance Connector"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDirectory = Join-Path $projectRoot "release"
$installedExecutable = Join-Path $env:LOCALAPPDATA "Programs\$productName\$productName.exe"

function Get-InstallerVersion([System.IO.FileInfo]$Installer) {
  $match = [regex]::Match($Installer.Name, "^Amex Local Finance Connector Setup (\d+\.\d+\.\d+)\.exe$")
  if (-not $match.Success) {
    throw "Installer name must be 'Amex Local Finance Connector Setup x.y.z.exe'."
  }
  return [version]$match.Groups[1].Value
}

function Get-RunningAppProcesses {
  return @(
    Get-Process -Name $productName -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -eq $installedExecutable
    }
  )
}

if ($InstallerPath) {
  $installer = Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
} else {
  $installer = Get-ChildItem -LiteralPath $releaseDirectory -File -Filter "Amex Local Finance Connector Setup *.exe" |
    ForEach-Object { [PSCustomObject]@{ File = $_; Version = Get-InstallerVersion $_ } } |
    Sort-Object Version -Descending |
    Select-Object -First 1 -ExpandProperty File
  if (-not $installer) {
    throw "No versioned installer was found in $releaseDirectory. Build the Windows installer first."
  }
}

$targetVersion = Get-InstallerVersion $installer
$running = Get-RunningAppProcesses
if ($running.Count -gt 0 -and (Test-Path -LiteralPath $installedExecutable)) {
  # The primary instance receives this command through Electron's single-instance channel
  # and releases encrypted runtime resources before it exits.
  Start-Process -FilePath $installedExecutable -ArgumentList "--quit-for-update" -Wait
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $running = Get-RunningAppProcesses
  } while ($running.Count -gt 0 -and (Get-Date) -lt $deadline)
}

if ($running.Count -gt 0) {
  if (-not $ForceCloseRunningApp) {
    throw "The app did not exit cleanly. Close it from the tray, or rerun with -ForceCloseRunningApp if you explicitly accept terminating it."
  }
  $running | Stop-Process -Force
}

$installerProcess = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
if ($null -ne $installerProcess.ExitCode -and $installerProcess.ExitCode -ne 0) {
  throw "Silent installer failed with exit code $($installerProcess.ExitCode)."
}
if (-not (Test-Path -LiteralPath $installedExecutable)) {
  throw "Silent installer completed but the installed application executable was not found."
}

$installedVersion = (Get-Item -LiteralPath $installedExecutable).VersionInfo.ProductVersion
if (-not $installedVersion.StartsWith("$targetVersion.")) {
  throw "Silent installer completed, but Windows reports version $installedVersion instead of $targetVersion."
}

Write-Output "Installed $productName $targetVersion without installer prompts."
if ($LaunchAfterInstall) {
  Start-Process -FilePath $installedExecutable
  Write-Output "Started $productName $targetVersion."
}
