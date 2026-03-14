param(
  [switch]$KeepMinikube
)

$ErrorActionPreference = "Continue"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
Set-Location $repoRoot

$stateDir = Join-Path $repoRoot ".runtime"
$pidFile = Join-Path $stateDir "dev-processes.json"

function Stop-PidIfRunning {
  param([int]$Pid)
  if ($Pid -and (Get-Process -Id $Pid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
  }
}

function Test-MinikubeRunning {
  try {
    $status = (minikube status --format='{{.Host}}|{{.Kubelet}}|{{.APIServer}}' 2>$null)
    return ($status -match 'Running\|Running\|Running')
  } catch {
    return $false
  }
}

Write-Host "Stopping local dev processes..."
if (Test-Path $pidFile) {
  try {
    $state = Get-Content $pidFile -Raw | ConvertFrom-Json
    Stop-PidIfRunning -Pid ([int]$state.portForwardPid)
    Stop-PidIfRunning -Pid ([int]$state.dashboardPid)
  } catch {
    Write-Warning "PID file parse failed, using fallback process matching."
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

if (Test-Path $pidFile) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$clusterRunning = Test-MinikubeRunning
if ($clusterRunning) {
  Write-Host "Uninstalling Helm releases (platform + wc-* if present)..."
  try {
    $releases = helm ls -A --output json 2>$null | ConvertFrom-Json
    foreach ($r in $releases) {
      if ($r.name -eq 'platform' -or $r.name -like 'wc-*') {
        helm uninstall $r.name -n $r.namespace | Out-Host
      }
    }
  } catch {
    Write-Warning "Helm cleanup skipped or failed: $($_.Exception.Message)"
  }

  Write-Host "Deleting platform/store namespaces..."
  try {
    kubectl get ns --no-headers 2>$null |
      ForEach-Object { ($_ -split '\s+')[0] } |
      Where-Object { $_ -eq 'platform' -or $_ -like 'store-*' } |
      ForEach-Object { kubectl delete ns $_ --wait=true | Out-Host }
  } catch {
    Write-Warning "Namespace cleanup skipped or failed: $($_.Exception.Message)"
  }
} else {
  Write-Host "Minikube is not running. Skipping Helm and namespace cleanup."
}

if (-not $KeepMinikube) {
  if ($clusterRunning) {
    Write-Host "Stopping Minikube..."
    try {
      minikube stop | Out-Host
    } catch {
      Write-Warning "Minikube stop skipped or failed: $($_.Exception.Message)"
    }
  } else {
    Write-Host "Minikube is already stopped."
  }
} else {
  Write-Host "Keeping Minikube running by request."
}

Write-Host ""
Write-Host "Down complete."
if ($KeepMinikube) {
  Write-Host "Minikube is still running."
} else {
  Write-Host "Minikube is stopped."
}
