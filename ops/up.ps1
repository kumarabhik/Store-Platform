param(
  [switch]$SkipImageBuild
)

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
    Write-Host "Switching Node to 24.5.0 via nvm..."
    nvm use 24.5.0 | Out-Host
  } else {
    Write-Warning "nvm not found. Ensure Node >= 20.19.0 (24.x recommended)."
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

function Ensure-Minikube {
  $status = ""
  try {
    $status = (minikube status --format='{{.Host}}|{{.Kubelet}}|{{.APIServer}}')
  } catch {
    $status = ""
  }

  if ($status -notmatch 'Running\|Running\|Running') {
    Write-Host "Starting Minikube..."
    minikube start | Out-Host
  } else {
    Write-Host "Minikube already running."
  }

  minikube addons enable ingress | Out-Host
}

function Deploy-Platform {
  Write-PlatformEnvOverrideFile -RepoRoot $repoRoot -OutputPath $helmEnvOverrideFile | Out-Null

  if (-not $SkipImageBuild) {
    Write-Host "Building API image in Minikube..."
    minikube image build -t store-platform/api-node:dev backend-node | Out-Host
  } else {
    Write-Host "Skipping image build by request."
  }

  Write-Host "Installing/upgrading platform chart..."
  helm upgrade --install platform ./charts/platform -n platform --create-namespace -f ./charts/platform/values-local.yaml -f $helmEnvOverrideFile --set api.image=store-platform/api-node:dev | Out-Host
  kubectl -n platform rollout status deploy/platform-api --timeout=300s | Out-Host
}

function Start-LocalDev {
  Write-Host "Starting API port-forward (8080 -> platform-api:80)..."
  $pf = Start-Process -FilePath kubectl -ArgumentList '-n','platform','port-forward','svc/platform-api','8080:80' -PassThru

  Write-Host "Starting dashboard dev server on 5173..."
  $dash = Start-Process -FilePath npm.cmd -ArgumentList '--prefix','dashboard','run','dev','--','--host','0.0.0.0','--port','5173' -PassThru

  $state = [ordered]@{
    startedAt = (Get-Date).ToString('o')
    portForwardPid = $pf.Id
    dashboardPid = $dash.Id
  } | ConvertTo-Json

  Set-Content -Path $pidFile -Value $state
}

Use-PreferredNode
Ensure-Minikube
Deploy-Platform
Start-LocalDev

Write-Host ""
Write-Host "Up complete."
Write-Host "Dashboard: http://127.0.0.1:5173"
Write-Host "API:       http://127.0.0.1:8080/healthz"
Write-Host "Stop all:  powershell -ExecutionPolicy Bypass -File .\\ops\\down.ps1"
