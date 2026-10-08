Set-StrictMode -Version Latest

function ConvertFrom-RepoEnvLine {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Line
  )

  $trimmed = $Line.Trim()
  if (-not $trimmed) { return $null }
  if ($trimmed.StartsWith("#")) { return $null }

  $match = [regex]::Match($trimmed, '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
  if (-not $match.Success) { return $null }

  $name = $match.Groups[1].Value
  $value = $match.Groups[2].Value.Trim()

  if ($value.Length -ge 2) {
    $quote = $value[0]
    if (($quote -eq '"' -or $quote -eq "'") -and $value[$value.Length - 1] -eq $quote) {
      $value = $value.Substring(1, $value.Length - 2)
    }
  }

  return [pscustomobject]@{
    Name = $name
    Value = $value
  }
}

function Get-RepoEnvMap {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  $result = [ordered]@{}
  foreach ($candidate in @(".env", ".env.local")) {
    $path = Join-Path $RepoRoot $candidate
    if (-not (Test-Path $path)) { continue }

    foreach ($line in Get-Content $path) {
      $entry = ConvertFrom-RepoEnvLine -Line $line
      if ($null -eq $entry) { continue }
      $result[$entry.Name] = [string]$entry.Value
    }
  }

  return $result
}

function Test-SecretEnvKey {
  param([string]$Name)
  # GROQ_API_KEY, STRIPE_SECRET_KEY, ADMIN_API_KEY, *_TOKEN, *_PASSWORD (but not RATE_LIMIT_MAX_KEYS).
  return ($Name -match '(KEY|TOKEN|PASSWORD)$') -or ($Name -match 'SECRET')
}

# Writes credential keys from .env/.env.local into the platform-api-env Secret (never into Helm values,
# which would make them plain env on the Deployment). Returns a checksum used to restart the pod on change.
function Sync-PlatformApiSecret {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string]$StateDir,
    [string]$Namespace = "platform",
    [string]$SecretName = "platform-api-env"
  )

  $repoEnv = Get-RepoEnvMap -RepoRoot $RepoRoot
  $lines = @()
  foreach ($key in ($repoEnv.Keys | Sort-Object)) {
    if ((Test-SecretEnvKey -Name $key) -and $repoEnv[$key]) { $lines += "$key=$($repoEnv[$key])" }
  }

  # List instead of `get <name>`: under $ErrorActionPreference=Stop, PowerShell 5.1 turns a native
  # command's stderr ("NotFound") into a terminating error even with 2>$null (SYSTEM.md G11).
  $existing = kubectl get namespaces -o name | Where-Object { $_ -eq "namespace/$Namespace" }
  if (-not $existing) { kubectl create namespace $Namespace | Out-Null }

  $envFile = Join-Path $StateDir "platform-api-env.tmp"
  try {
    # UTF-8 without BOM: a BOM would become part of the first key name.
    [System.IO.File]::WriteAllLines($envFile, [string[]]$lines)
    kubectl -n $Namespace create secret generic $SecretName --from-env-file=$envFile --dry-run=client -o yaml |
      kubectl apply -f - | Out-Null
  } finally {
    Remove-Item $envFile -Force -ErrorAction SilentlyContinue
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))
  return (([System.BitConverter]::ToString($hash)) -replace '-', '').ToLowerInvariant()
}

# The demo store every installation starts with (DESIGN.md §7.2). Same chart the provisioner will use.
function Install-DefaultStore {
  param(
    [switch]$OnlyIfMissing
  )

  if ($OnlyIfMissing) {
    $release = helm ls -n store-default -q | Where-Object { $_ -eq 'store-default' }
    if ($release) {
      Write-Host "Default store already installed."
      return
    }
  }

  Write-Host "Installing/upgrading default store (first install pulls images and WooCommerce; ~5-10 min)..."
  helm upgrade --install store-default ./charts/store-woocommerce -n store-default --create-namespace `
    -f ./charts/store-woocommerce/values-local.yaml --wait --timeout 20m | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Default store install failed. Inspect: kubectl -n store-default get pods; kubectl -n store-default logs job/store-default-init"
  }
}

function Write-PlatformEnvOverrideFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [string]$EnvChecksum = ""
  )

  $repoEnv = Get-RepoEnvMap -RepoRoot $RepoRoot
  $apiEnv = [ordered]@{}

  foreach ($key in $repoEnv.Keys) {
    if ($key -like "VITE_*") { continue }
    if ($key -notmatch '^[A-Z0-9_]+$') { continue }
    if (Test-SecretEnvKey -Name $key) { continue }
    $apiEnv[$key] = [string]$repoEnv[$key]
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("api:")
  $lines.Add("  envChecksum: '$EnvChecksum'")
  if ($apiEnv.Count -eq 0) {
    $lines.Add("  env: {}")
  } else {
    $lines.Add("  env:")
    foreach ($key in ($apiEnv.Keys | Sort-Object)) {
      $escaped = $apiEnv[$key].Replace("'", "''")
      $lines.Add("    ${key}: '$escaped'")
    }
  }

  Set-Content -Path $OutputPath -Value $lines
  return $OutputPath
}
