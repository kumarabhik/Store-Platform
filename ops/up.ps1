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
    # Calico: the default minikube CNI silently ignores NetworkPolicies (SYSTEM.md L15).
    minikube start --cni=calico | Out-Host
  } else {
    Write-Host "Minikube already running."
  }

  minikube addons enable ingress | Out-Host
  kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s | Out-Host
}

function Deploy-Platform {
  $envChecksum = Sync-PlatformApiSecret -RepoRoot $repoRoot -StateDir $stateDir
  Write-PlatformEnvOverrideFile -RepoRoot $repoRoot -OutputPath $helmEnvOverrideFile -EnvChecksum $envChecksum | Out-Null

  if (-not $SkipImageBuild) {
    Write-Host "Building API image in Minikube..."
    minikube image build -t store-platform/api-node:dev backend-node | Out-Host
    # The default store's MCP server; values-local.yaml uses it with pullPolicy Never.
    Write-Host "Building woo-mcp image in Minikube..."
    minikube image build -t store-platform/woo-mcp:dev mcp-servers/woo-mcp | Out-Host
    Write-Host "Building notes-mcp and everything-mcp images in Minikube..."
    minikube image build -t store-platform/notes-mcp:dev mcp-servers/notes-mcp | Out-Host
    minikube image build -t store-platform/everything-mcp:dev mcp-servers/everything-mcp | Out-Host
    Write-Host "Building dashboard image in Minikube..."
    minikube image build -t store-platform/dashboard:dev dashboard | Out-Host
  } else {
    Write-Host "Skipping image build by request."
  }

  Write-Host "Installing/upgrading platform chart..."
  helm upgrade --install platform ./charts/platform -n platform --create-namespace -f ./charts/platform/values-local.yaml -f $helmEnvOverrideFile --set api.image=store-platform/api-node:dev | Out-Host
  if (-not $SkipImageBuild) {
    # Same :dev tags after a rebuild, so Kubernetes would keep the old containers (SYSTEM.md L12).
    kubectl -n platform rollout restart deploy/platform-api deploy/platform-dashboard | Out-Host
  }
  kubectl -n platform rollout status deploy/platform-api --timeout=300s | Out-Host
  kubectl -n platform rollout status deploy/platform-dashboard --timeout=300s | Out-Host
}

function Test-LocalPortListening {
  param([int]$Port)

  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connected = $client.ConnectAsync("127.0.0.1", $Port).Wait(500)
    return ($connected -and $client.Connected)
  } catch {
    return $false
  } finally {
    if ($client) { $client.Dispose() }
  }
}

function Test-HttpReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -Method GET -UseBasicParsing -TimeoutSec 3
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Start-ProcessUntilListening {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [string]$HealthUrl = "",
    [int]$MaxAttempts = 5
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Write-Host "$Label (attempt $attempt/$MaxAttempts)..."
    $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru

    for ($tick = 0; $tick -lt 20; $tick++) {
      Start-Sleep -Seconds 1
      $portReady = Test-LocalPortListening -Port $Port
      $serviceReady = if ($HealthUrl) { $portReady -and (Test-HttpReady -Url $HealthUrl) } else { $portReady }
      if ($serviceReady) {
        return $proc
      }
      if ($proc.HasExited) {
        break
      }
    }

    if (-not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }

  throw "$Label failed to listen on port $Port."
}

function Start-LocalDev {
  $pf = Start-ProcessUntilListening `
    -Label "Starting API port-forward (8080 -> platform-api:80)" `
    -FilePath "kubectl" `
    -ArgumentList @('-n','platform','port-forward','svc/platform-api','8080:80') `
    -Port 8080 `
    -HealthUrl "http://127.0.0.1:8080/healthz"

  $ingress = Start-ProcessUntilListening `
    -Label "Starting ingress bridge (8088 -> ingress-nginx-controller:80)" `
    -FilePath "kubectl" `
    -ArgumentList @('-n','ingress-nginx','port-forward','svc/ingress-nginx-controller','8088:80') `
    -Port 8088

  $dash = Start-ProcessUntilListening `
    -Label "Starting dashboard dev server on 5173" `
    -FilePath "npm.cmd" `
    -ArgumentList @('--prefix','dashboard','run','dev','--','--host','0.0.0.0','--port','5173') `
    -Port 5173

  $state = [ordered]@{
    startedAt = (Get-Date).ToString('o')
    portForwardPid = $pf.Id
    ingressPortForwardPid = $ingress.Id
    dashboardPid = $dash.Id
  } | ConvertTo-Json

  Set-Content -Path $pidFile -Value $state
}

Use-PreferredNode
Ensure-Minikube
Deploy-Platform
Install-DefaultStore
Write-Host "Installing/upgrading upstream MCP servers (notes-mcp, everything-mcp)..."
helm upgrade --install upstreams ./charts/mcp-upstreams -n mcp-servers --create-namespace `
  -f ./charts/mcp-upstreams/values-local.yaml --wait --timeout 5m | Out-Host
if (-not $SkipImageBuild) {
  # Same :dev tag after a rebuild, so Kubernetes would keep the old container (SYSTEM.md L12).
  kubectl -n store-default rollout restart deploy/store-default-woo-mcp | Out-Host
  kubectl -n mcp-servers rollout restart deploy/notes-mcp deploy/everything-mcp | Out-Host
}
Start-LocalDev

Write-Host ""
Write-Host "Up complete."
Write-Host "Dashboard: http://dashboard.127.0.0.1.nip.io:8088  (in-cluster; Vite dev server: http://127.0.0.1:5173)"
Write-Host "Gateway:   http://api.127.0.0.1.nip.io:8088/mcp"
Write-Host "API:       http://127.0.0.1:8080/healthz"
Write-Host "Store:     http://store.127.0.0.1.nip.io:8088  (admin: /wp-admin, user 'admin')"
Write-Host "Stores:    http://store-<id>.127.0.0.1.nip.io:8088"
Write-Host "Stop all:  powershell -ExecutionPolicy Bypass -File .\\ops\\down.ps1"
