$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $AppRoot 'backend'
$OrchestratorRoot = Join-Path $AppRoot 'orchestrator'
$AppDataRoot = Join-Path $env:LOCALAPPDATA 'ShopAI'
$VenvPython = Join-Path $AppDataRoot 'backend-venv\Scripts\python.exe'
$OrchestratorPython = Join-Path $AppDataRoot 'orchestrator-venv\Scripts\python.exe'
$InstallCompletionMarker = Join-Path $AppDataRoot 'install-complete'
$StorageRoot = Join-Path $AppDataRoot 'projects'
$ProcessDirectory = Join-Path $AppDataRoot 'processes'
$LogDirectory = Join-Path $AppDataRoot 'logs'
$TranscriptStarted = $false
$BackendUrl = 'http://127.0.0.1:8000/'
$OrchestratorUrl = 'http://127.0.0.1:8010/'

try {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    Start-Transcript -Path (Join-Path $LogDirectory 'launcher.log') -Append | Out-Null
    $TranscriptStarted = $true
    Write-Host "Starting ShopAI from $AppRoot"
    $MissingComponents = @()
    if (-not (Test-Path $VenvPython)) {
        $MissingComponents += 'backend Python environment'
    }
    if (-not (Test-Path $OrchestratorPython)) {
        $MissingComponents += 'LLM orchestrator Python environment'
    }
    if (-not (Test-Path $InstallCompletionMarker)) {
        $MissingComponents += 'Python dependency installation'
    }
    if ($MissingComponents.Count -gt 0) {
        $MissingList = $MissingComponents -join ', '
        throw "ShopAI installation is incomplete: missing $MissingList. Check $AppDataRoot\install-backend.log, then run ShopAI-Setup.exe again."
    }

    New-Item -ItemType Directory -Force -Path $StorageRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $ProcessDirectory | Out-Null
    $env:SHOPAI_STORAGE_ROOT = $StorageRoot
    $env:SHOPAI_LOG_DIR = $LogDirectory
    $env:PYTHONUTF8 = '1'
    $env:STUDIO_LLM_WEBHOOK_URL = 'http://127.0.0.1:8010/webhook/llm'
    $env:BACKEND_BASE_URL = 'http://127.0.0.1:8000'

    $SettingsPath = Join-Path $AppDataRoot 'llm-settings.json'
    if (Test-Path $SettingsPath) {
        $Settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
        $env:LLM_PROVIDER = $Settings.provider
        $KeyVariable = switch ($Settings.provider) {
            'openai' { 'OPENAI_API_KEY' }
            'anthropic' { 'ANTHROPIC_API_KEY' }
            'xai' { 'XAI_API_KEY' }
            'openrouter' { 'OPENROUTER_API_KEY' }
            default { $null }
        }
        if ($KeyVariable -and $Settings.protectedApiKey) {
            $SecureKey = ConvertTo-SecureString -String $Settings.protectedApiKey
            $KeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
            try {
                [Environment]::SetEnvironmentVariable(
                    $KeyVariable,
                    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($KeyPointer),
                    'Process'
                )
            }
            finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($KeyPointer)
                $SecureKey.Dispose()
            }
        }
    }

    $RunningShopAI = $false
    try {
        $Response = Invoke-WebRequest -Uri $BackendUrl -TimeoutSec 2 -UseBasicParsing
        $RunningShopAI = $Response.Content.Contains('<div id="root">')
    }
    catch {
        $RunningShopAI = $false
    }

    if (-not $RunningShopAI) {
        $Port = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
        if ($Port) {
            throw 'Port 8000 is already in use by another application. Close it and try again.'
        }

        $Server = Start-Process -FilePath $VenvPython `
            -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000') `
            -WorkingDirectory $BackendRoot `
            -RedirectStandardOutput (Join-Path $LogDirectory 'backend-stdout.log') `
            -RedirectStandardError (Join-Path $LogDirectory 'backend-stderr.log') `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -LiteralPath (Join-Path $ProcessDirectory 'backend.pid') -Value $Server.Id

        $Deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $Deadline) {
            if ($Server.HasExited) {
                throw 'The ShopAI backend stopped during startup.'
            }
            try {
                $Response = Invoke-WebRequest -Uri $BackendUrl -TimeoutSec 2 -UseBasicParsing
                if ($Response.Content.Contains('<div id="root">')) {
                    $RunningShopAI = $true
                    break
                }
            }
            catch {
                Start-Sleep -Milliseconds 500
            }
        }

        if (-not $RunningShopAI) {
            Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue
            throw 'ShopAI did not start within 60 seconds.'
        }
    }

    $OrchestratorReady = $false
    try {
        $Response = Invoke-WebRequest -Uri $OrchestratorUrl -TimeoutSec 2 -UseBasicParsing
        $OrchestratorReady = $Response.Content.Contains('shopai-orchestrator')
    }
    catch {
        $OrchestratorReady = $false
    }

    if (-not $OrchestratorReady) {
        $Port = Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue
        if ($Port) {
            throw 'Port 8010 is already in use by another application. Close it and try again.'
        }

        $Agent = Start-Process -FilePath $OrchestratorPython `
            -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8010') `
            -WorkingDirectory $OrchestratorRoot `
            -RedirectStandardOutput (Join-Path $LogDirectory 'orchestrator-stdout.log') `
            -RedirectStandardError (Join-Path $LogDirectory 'orchestrator-stderr.log') `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -LiteralPath (Join-Path $ProcessDirectory 'orchestrator.pid') -Value $Agent.Id

        $Deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $Deadline) {
            if ($Agent.HasExited) {
                throw 'The ShopAI LLM orchestrator stopped during startup.'
            }
            try {
                $Response = Invoke-WebRequest -Uri $OrchestratorUrl -TimeoutSec 2 -UseBasicParsing
                if ($Response.Content.Contains('shopai-orchestrator')) {
                    $OrchestratorReady = $true
                    break
                }
            }
            catch {
                Start-Sleep -Milliseconds 500
            }
        }

        if (-not $OrchestratorReady) {
            Stop-Process -Id $Agent.Id -Force -ErrorAction SilentlyContinue
            throw 'The ShopAI LLM orchestrator did not start within 30 seconds.'
        }
    }

    Start-Process $BackendUrl
}
catch {
    Write-Host "ShopAI launch failed: $($_.Exception.Message)"
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "$($_.Exception.Message)`nLogs: $LogDirectory", 'ShopAI', 'OK', 'Error'
    ) | Out-Null
    exit 1
}
finally {
    if ($TranscriptStarted) {
        Stop-Transcript | Out-Null
    }
}
