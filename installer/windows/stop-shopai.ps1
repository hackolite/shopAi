$AppDataRoot = Join-Path $env:LOCALAPPDATA 'ShopAI'
$ProcessDirectory = Join-Path $AppDataRoot 'processes'
$VenvPython = Join-Path $AppDataRoot 'backend-venv\Scripts\python.exe'
$OrchestratorPython = Join-Path $AppDataRoot 'orchestrator-venv\Scripts\python.exe'

foreach ($Service in @(
    @{ Name = 'backend'; Python = $VenvPython; Command = 'uvicorn main:app' },
    @{ Name = 'orchestrator'; Python = $OrchestratorPython; Command = 'uvicorn app.main:app' }
)) {
    $PidFile = Join-Path $ProcessDirectory "$($Service.Name).pid"
    if (-not (Test-Path $PidFile)) {
        continue
    }

    $ProcessId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$ProcessId)) {
        $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if ($ProcessInfo -and
            $ProcessInfo.ExecutablePath -eq $Service.Python -and
            $ProcessInfo.CommandLine.Contains($Service.Command)) {
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
