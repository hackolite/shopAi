$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $AppRoot 'backend'
$OrchestratorRoot = Join-Path $AppRoot 'orchestrator'
$PythonRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'
$PythonExe = Join-Path $PythonRoot 'python.exe'
$AppDataRoot = Join-Path $env:LOCALAPPDATA 'ShopAI'
$VenvRoot = Join-Path $AppDataRoot 'backend-venv'
$OrchestratorVenvRoot = Join-Path $AppDataRoot 'orchestrator-venv'
$VenvPython = Join-Path $VenvRoot 'Scripts\python.exe'
$OrchestratorVenvPython = Join-Path $OrchestratorVenvRoot 'Scripts\python.exe'

try {
    $Launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($Launcher) {
        & $Launcher.Source -3.12 -c 'import sys' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $PythonExe = (& $Launcher.Source -3.12 -c 'import sys; print(sys.executable)').Trim()
        }
    }

    if (-not (Test-Path $PythonExe)) {
        $InstallerPath = Join-Path $env:TEMP 'python-3.12.10-amd64.exe'
        $InstallerUrl = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'
        Write-Host 'Downloading Python 3.12...'
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing
        $InstallArgs = @(
            '/quiet',
            'InstallAllUsers=0',
            "TargetDir=$PythonRoot",
            'Include_pip=1',
            'Include_launcher=1',
            'InstallLauncherAllUsers=0',
            'PrependPath=0',
            'Include_test=0'
        )
        $PythonSetup = Start-Process -FilePath $InstallerPath -ArgumentList $InstallArgs -Wait -PassThru
        Remove-Item -LiteralPath $InstallerPath -Force
        if ($PythonSetup.ExitCode -ne 0 -or -not (Test-Path $PythonExe)) {
            throw 'Python 3.12 could not be installed.'
        }
    }

    if (-not (Test-Path $VenvPython)) {
        & $PythonExe -m venv $VenvRoot
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not create the ShopAI Python environment.'
        }
    }

    foreach ($Environment in @(
        @{ Python = $VenvPython; Path = $VenvRoot; Requirements = (Join-Path $BackendRoot 'requirements.txt') },
        @{ Python = $OrchestratorVenvPython; Path = $OrchestratorVenvRoot; Requirements = (Join-Path $OrchestratorRoot 'requirements.txt') }
    )) {
        if (-not (Test-Path $Environment.Python)) {
            & $PythonExe -m venv $Environment.Path
            if ($LASTEXITCODE -ne 0) {
                throw "Could not create the Python environment at $($Environment.Path)."
            }
        }
        & $Environment.Python -m pip install --disable-pip-version-check -r $Environment.Requirements
        if ($LASTEXITCODE -ne 0) {
            throw "Could not install dependencies from $($Environment.Requirements)."
        }
    }
}
catch {
    Write-Error $_
    exit 1
}
