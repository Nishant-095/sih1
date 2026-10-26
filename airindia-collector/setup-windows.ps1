$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'Windows Package Manager (winget) is required. Install App Installer from Microsoft, then rerun this script.'
}
function Install-IfMissing($command, $packageId) {
  if (Get-Command $command -ErrorAction SilentlyContinue) { return }
  & winget install --id $packageId --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Could not install $packageId with winget." }
  $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path','User')
}

Install-IfMissing 'node' 'OpenJS.NodeJS.LTS'
$nodeMajor = 0
try { $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0]) }
catch { $nodeMajor = 0 }
if ($nodeMajor -lt 20) {
  & winget upgrade --id 'OpenJS.NodeJS.LTS' --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    & winget install --id 'OpenJS.NodeJS.LTS' --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Could not install Node.js 20 or newer with winget.' }
  }
  $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path','User')
  try { $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0]) }
  catch { $nodeMajor = 0 }
  if ($nodeMajor -lt 20) { throw 'The terminal still resolves an older Node.js. Open a new PowerShell window and rerun setup.' }
}
$python312 = $false
if (Get-Command py -ErrorAction SilentlyContinue) {
  try { & py -3.12 --version 2>$null; $python312 = ($LASTEXITCODE -eq 0) }
  catch { $python312 = $false }
}
if (-not $python312) {
  & winget install --id 'Python.Python.3.12' --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Could not install Python 3.12 with winget.' }
  $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path','User')
}
Install-IfMissing 'ffmpeg' 'Gyan.FFmpeg'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) {
  & winget install --id 'Google.Chrome' --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Could not install Google Chrome with winget.' }
}
$env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
  [Environment]::GetEnvironmentVariable('Path','User')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'FFmpeg was installed but is not yet on PATH. Open a new PowerShell window and run start-windows.ps1.'
}
& npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
& "$PSScriptRoot\start-windows.ps1"
