$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
Set-Location $repoRoot
. (Join-Path $scriptDir "platform-env.ps1")

$stateDir = Join-Path $repoRoot ".runtime"
$pidFile = Join-Path $stateDir "dev-processes.json"
$helmEnvOverrideFile = Join-Path $stateDir "platform-env.override.yaml"
if (-not (Test-Path $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir | Out-Null
}

function Use-PreferredNode {
  if (Get-Command nvm -ErrorAction SilentlyContinue) {
    nvm use 24.5.0 | Out-Host
  }

  $nodeCandidates = @()
  if ($env:NVM_SYMLINK) { $nodeCandidates += $env:NVM_SYMLINK }
  if ($env:NVM_HOME) { $nodeCandidates += (Join-Path $env:NVM_HOME "v24.5.0") }

  foreach ($candidate in $nodeCandidates) {
    $nodeExe = Join-Path $candidate "node.exe"
    if ((Test-Path $nodeExe) -and ($env:Path -notlike "*$candidate*")) {
      $env:Path = "$candidate;$env:Path"
      break
    }
  }

  $rawVersion = (node -v).Trim().TrimStart('v')
  if ([version]$rawVersion -lt [version]'20.19.0') {
    throw "Node $rawVersion is too old for current Vite. Use Node >= 20.19.0."
  }
}

function Ensure-MinikubeRunning {
  $status = ""
  try {
    $status = (minikube status --format='{{.Host}}|{{.Kubelet}}|{{.APIServer}}')
  } catch {
    $status = ""
  }

  if ($status -notmatch 'Running\|Running\|Running') {
    Write-Host "Minikube not running. Starting it..."
    minikube start | Out-Host
    minikube addons enable ingress | Out-Host
  }
}

function Ensure-PlatformPresent {
  $release = helm ls -n platform -q | Where-Object { $_ -eq 'platform' }
  if (-not $release) {
    throw "Platform release not found in namespace 'platform'. Run .\\ops\\up.ps1 first."
  }
}

function Apply-PlatformConfig {
  Write-PlatformEnvOverrideFile -RepoRoot $repoRoot -OutputPath $helmEnvOverrideFile | Out-Null
  helm upgrade --install platform ./charts/platform -n platform -f ./charts/platform/values-local.yaml -f $helmEnvOverrideFile --set api.image=store-platform/api-node:dev | Out-Host
  kubectl -n platform rollout status deploy/platform-api --timeout=300s | Out-Host
}

function Stop-StaleLocalProcesses {
  if (Test-Path $pidFile) {
    try {
      $state = Get-Content $pidFile -Raw | ConvertFrom-Json
      foreach ($pid in @($state.portForwardPid, $state.dashboardPid)) {
        if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
          Stop-Process -Id $pid -Force
        }
      }
    } catch {
      Write-Warning "Could not read PID file. Continuing with fallback cleanup."
    }
  }

  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -match 'port-forward\s+svc/platform-api\s+8080:80' -or
      $_.CommandLine -match 'vite\\bin\\vite\.js.*--port\s+5173' -or
      $_.CommandLine -match 'npm-cli\.js.*--prefix\s+dashboard\s+run\s+dev'
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-LocalDev {
  $pf = Start-Process -FilePath kubectl -ArgumentList '-n','platform','port-forward','svc/platform-api','8080:80' -PassThru
  $dash = Start-Process -FilePath npm.cmd -ArgumentList '--prefix','dashboard','run','dev','--','--host','0.0.0.0','--port','5173' -PassThru

  $state = [ordered]@{
    resumedAt = (Get-Date).ToString('o')
    portForwardPid = $pf.Id
    dashboardPid = $dash.Id
  } | ConvertTo-Json

  Set-Content -Path $pidFile -Value $state
}

Use-PreferredNode
Ensure-MinikubeRunning
Ensure-PlatformPresent
Apply-PlatformConfig
Stop-StaleLocalProcesses
Start-LocalDev

Write-Host ""
Write-Host "Resume complete."
Write-Host "Dashboard: http://127.0.0.1:5173"
Write-Host "API:       http://127.0.0.1:8080/healthz"
