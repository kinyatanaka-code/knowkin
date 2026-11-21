# knowkin for Gemini updater. Runs every 15 min from Task Scheduler. ASCII only.
# Checks the version on GitHub (kinyatanaka-code/knowkin) and, if it changed, overwrites the extension folder.
# The extension notices the new manifest version and reloads itself.
$ErrorActionPreference = 'Stop'
$Raw = 'https://raw.githubusercontent.com/kinyatanaka-code/knowkin/main'
$Dest = Join-Path $env:LOCALAPPDATA 'knowkin-gemini'
$Dir = Join-Path $env:LOCALAPPDATA 'knowkin-gemini-updater'; New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Log = Join-Path $Dir 'update.log'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $v = (Invoke-RestMethod -UseBasicParsing -Uri ("$Raw/ext/gemini/manifest.json?t=" + [DateTime]::Now.Ticks)).version
  $have = ''; $mf = Join-Path $Dest 'manifest.json'
  if (Test-Path $mf) { $have = (Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json).version }
  if ($v -and $v -ne $have) {
    $zip = Join-Path $env:TEMP 'knowkin-gemini-new.zip'
    Invoke-WebRequest -UseBasicParsing -Uri ("$Raw/public/knowkin-gemini-ext.zip?t=" + [DateTime]::Now.Ticks) -OutFile $zip
    $tmp = Join-Path $env:TEMP ('knowkin-gemini-' + [guid]::NewGuid().ToString())
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    # manifest.json is copied last, so the extension never reloads with half-copied files
    Get-ChildItem -Path $tmp | Where-Object { $_.Name -ne 'manifest.json' } | Copy-Item -Destination $Dest -Recurse -Force
    Copy-Item -Path (Join-Path $tmp 'manifest.json') -Destination $Dest -Force
    Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force
    Add-Content $Log ('{0} updated {1} -> {2}' -f (Get-Date), $have, $v)
  }
} catch { Add-Content $Log ('{0} error {1}' -f (Get-Date), $_.Exception.Message) }
