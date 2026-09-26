# KTLAB test runner (Windows / PowerShell)
#   .\run-tests.ps1            smoke + functional + firmware
#   .\run-tests.ps1 -Smoke     just the boot check
#
# Starts a throwaway Chrome with remote debugging and a static file server,
# runs the suites against the live page, then tears both down.

param([switch]$Smoke, [switch]$Keep)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$profile = Join-Path $env:TEMP 'opencode\ktlab-chrome'

function Wait-Port($port, $path, $seconds = 15) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest "http://127.0.0.1:$port$path" -UseBasicParsing -TimeoutSec 1 | Out-Null; return $true }
    catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}

# ── static server ──
if (-not (Wait-Port 8731 '/' 1)) {
  Start-Process -FilePath node -ArgumentList 'serve.cjs' -WorkingDirectory $root -WindowStyle Hidden
  if (-not (Wait-Port 8731 '/' 10)) { throw 'static server did not start' }
}

# ── chrome (headless) ──
# Headless, deliberately. The windowed runner used to raise Chrome to the
# foreground, which un-freezes requestAnimationFrame but also hijacks the
# desktop mid-edit. Headless has no window to raise, and the reason the raise
# existed is verified rather than assumed: see the rAF probe below, which fails
# the run outright if frames are not actually being produced.
if (-not (Wait-Port 9222 '/json/version' 1)) {
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
              "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
              "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
             Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) { throw 'Chrome not found — these tests need a real browser.' }
  Start-Process -FilePath $chrome -ArgumentList '--headless=new',
    '--remote-debugging-port=9222', "--user-data-dir=$profile",
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--window-size=1600,1000', 'http://127.0.0.1:8731/' -WindowStyle Hidden
  if (-not (Wait-Port 9222 '/json/version' 20)) { throw 'Chrome did not expose the debugging port' }
  Start-Sleep -Seconds 2
}

$fail = 0
function Run($label, $script) {
  Write-Host "`n=== $label ===" -ForegroundColor Cyan
  & node (Join-Path $root $script)
  if ($LASTEXITCODE -ne 0) { $script:fail = 1 }
}

Run 'syntax'      'syntax.cjs'
Run 'contrast'    'contrast.mjs'
Run 'raf'         'raf-probe.mjs'
Run 'smoke'       'smoke.cjs'
if (-not $Smoke) {
  Run 'functional' 'functional.cjs'
  Run 'firmware'   'fwtest.cjs'
}

Write-Host ""
if ($fail) { Write-Host 'SUITE FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'all suites passed' -ForegroundColor Green
if (-not $Keep) { Write-Host '(leaving Chrome and the server running — Ctrl+C to stop)' }
