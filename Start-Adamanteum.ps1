$ErrorActionPreference = 'Stop'
$adamanteumRoot = $PSScriptRoot
$adamanteumData = if ($env:ADAMANTEUM_DATA_DIR) { [IO.Path]::GetFullPath($env:ADAMANTEUM_DATA_DIR) } else { Join-Path $adamanteumRoot '.data' }
$adamanteumPort = if ($env:PORT) { [int]$env:PORT } else { 4173 }
$adamanteumUrl = "http://127.0.0.1:$adamanteumPort"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer, then open Start-Adamanteum.ps1 again.' }
$adamanteumNodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($adamanteumNodeMajor -lt 24) { throw 'Adamanteum needs Node.js 24 or newer. Your vault has not been changed.' }
$adamanteumDependencies = (Get-Content -LiteralPath (Join-Path $adamanteumRoot 'package.json') -Raw | ConvertFrom-Json).dependencies
$adamanteumInstallNeeded = $false
foreach ($adamanteumDependency in $adamanteumDependencies.PSObject.Properties) {
    $adamanteumInstalled = Join-Path $adamanteumRoot ('node_modules\' + $adamanteumDependency.Name + '\package.json')
    if (-not (Test-Path -LiteralPath $adamanteumInstalled)) { $adamanteumInstallNeeded = $true; break }
    if ((Get-Content -LiteralPath $adamanteumInstalled -Raw | ConvertFrom-Json).version -ne $adamanteumDependency.Value) { $adamanteumInstallNeeded = $true; break }
}
if ($adamanteumInstallNeeded) {
    Push-Location $adamanteumRoot
    try {
        if (Test-Path -LiteralPath (Join-Path $adamanteumRoot 'package-lock.json')) { & npm ci --ignore-scripts }
        else { & npm install --ignore-scripts --no-audit --no-fund }
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your connection and run this launcher again. Your vault is unchanged.' }
    } finally { Pop-Location }
}
$adamanteumConfig = Join-Path $adamanteumData 'local-config.json'
if (-not $env:ADAMANTEUM_VAULT -and -not (Test-Path -LiteralPath $adamanteumConfig)) {
    Add-Type -AssemblyName System.Windows.Forms
    $adamanteumPicker = New-Object System.Windows.Forms.FolderBrowserDialog
    $adamanteumPicker.Description = 'Choose your Obsidian vault or Markdown folder. Adamanteum will not change the originals.'
    if ($adamanteumPicker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
    New-Item -ItemType Directory -Path $adamanteumData -Force | Out-Null
    @{ vault = $adamanteumPicker.SelectedPath } | ConvertTo-Json | Set-Content -LiteralPath $adamanteumConfig -Encoding utf8
}
$adamanteumChosenVault = if ($env:ADAMANTEUM_VAULT) { $env:ADAMANTEUM_VAULT } else { (Get-Content -LiteralPath $adamanteumConfig -Raw | ConvertFrom-Json).vault }
if (-not $adamanteumChosenVault) { throw 'The local configuration does not identify a vault folder.' }
if (-not [IO.Path]::IsPathRooted($adamanteumChosenVault)) { $adamanteumChosenVault = Join-Path $adamanteumRoot $adamanteumChosenVault }
$adamanteumChosenVault = [IO.Path]::GetFullPath($adamanteumChosenVault)
if ($adamanteumChosenVault.Length -gt ([IO.Path]::GetPathRoot($adamanteumChosenVault)).Length) { $adamanteumChosenVault = $adamanteumChosenVault.TrimEnd('\') }
$adamanteumChosenVault = $adamanteumChosenVault.ToLowerInvariant()
$adamanteumHash = [Security.Cryptography.SHA256]::Create()
try { $adamanteumVaultId = ([BitConverter]::ToString($adamanteumHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($adamanteumChosenVault)))).Replace('-','').ToLowerInvariant() }
finally { $adamanteumHash.Dispose() }
try {
    $adamanteumHealth = Invoke-RestMethod "$adamanteumUrl/api/status" -TimeoutSec 3
} catch {
    if (Test-Path -LiteralPath (Join-Path $adamanteumData 'index-receipt.json')) { $env:ADAMANTEUM_REUSE_INDEX = '1' }
    Start-Process -FilePath 'node' -ArgumentList '--max-old-space-size=3072','server.mjs' -WorkingDirectory $adamanteumRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $adamanteumRoot 'server.log') -RedirectStandardError (Join-Path $adamanteumRoot 'server-error.log')
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { $adamanteumHealth = Invoke-RestMethod "$adamanteumUrl/api/status" -TimeoutSec 2; break } catch {}
    }
}
if (-not $adamanteumHealth) { throw 'Adamanteum did not start. Check server-error.log.' }
if ($adamanteumHealth.schema -ne 'adamanteum.status/v1') { throw "Another application or older Adamanteum build is using port $adamanteumPort. Close that process before starting this build." }
if ($adamanteumHealth.vaultId -ne $adamanteumVaultId) { throw 'The running Adamanteum instance belongs to a different vault. Close that instance first. This launcher will not open another vault instead of yours.' }
Start-Process $adamanteumUrl
