$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
    -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'Node.js is missing. Run setup-windows.ps1 first.'
}
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}
& node src/server.mjs
if ($LASTEXITCODE -ne 0) { throw 'Air India server exited with an error.' }
