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

function Write-PlatformEnvOverrideFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
  )

  $repoEnv = Get-RepoEnvMap -RepoRoot $RepoRoot
  $apiEnv = [ordered]@{}

  foreach ($key in $repoEnv.Keys) {
    if ($key -like "VITE_*") { continue }
    if ($key -notmatch '^[A-Z0-9_]+$') { continue }
    $apiEnv[$key] = [string]$repoEnv[$key]
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("api:")
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
