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
$LogPath = Join-Path $AppDataRoot 'install-backend.log'
$CompletionMarker = Join-Path $AppDataRoot 'install-complete'
$TranscriptStarted = $false
$InstallFailed = $false

try {
    New-Item -ItemType Directory -Force -Path $AppDataRoot | Out-Null
    Remove-Item -LiteralPath $CompletionMarker -Force -ErrorAction SilentlyContinue
    Start-Transcript -Path $LogPath -Append | Out-Null
    $TranscriptStarted = $true
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # Microsoft Store Python redirects LOCALAPPDATA, hiding venvs from the launch scripts.
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        $InstallerPath = Join-Path $env:TEMP 'python-3.12.10-amd64.exe'
        $InstallerUrl = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'
        Write-Host 'Downloading Python 3.12...'
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing
        $InstallArgs = @(
            '/quiet',
            'InstallAllUsers=0',
            "TargetDir=`"$PythonRoot`"",
            'Include_pip=1',
            'Include_launcher=1',
            'InstallLauncherAllUsers=0',
            'PrependPath=0',
            'Include_test=0'
        )
        $PythonSetup = Start-Process -FilePath $InstallerPath -ArgumentList $InstallArgs -Wait -PassThru
        Remove-Item -LiteralPath $InstallerPath -Force
        if ($PythonSetup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
            throw 'Python 3.12 could not be installed.'
        }
    }

    # Python bundles its own C runtime, but JuPedSim also needs the C++ runtime.
    $RuntimeProbe = "import ctypes; [ctypes.WinDLL(name) for name in ('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')]"
    & $PythonExe -c $RuntimeProbe
    if ($LASTEXITCODE -ne 0) {
        $RuntimeInstaller = Join-Path $AppDataRoot 'vc_redist.x64.exe'
        try {
            Write-Host 'Installing Microsoft Visual C++ x64 runtime (administrator approval may be required)...'
            Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' `
                -OutFile $RuntimeInstaller -UseBasicParsing
            $Signature = Get-AuthenticodeSignature -LiteralPath $RuntimeInstaller
            if ($Signature.Status -ne 'Valid' -or
                $Signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
                throw 'The Microsoft Visual C++ runtime installer signature could not be verified.'
            }
            $RuntimeSetup = Start-Process -FilePath $RuntimeInstaller -Verb RunAs `
                -ArgumentList @('/install', '/quiet', '/norestart', '/log', "`"$(Join-Path $AppDataRoot 'install-vcredist.log')`"") `
                -Wait -PassThru
            if ($RuntimeSetup.ExitCode -eq 3010) {
                throw 'The Visual C++ runtime requires a Windows restart. Restart Windows, then run ShopAI-Setup.exe again.'
            }
            if ($RuntimeSetup.ExitCode -notin @(0, 1638)) {
                throw "Microsoft Visual C++ runtime installation failed (exit code $($RuntimeSetup.ExitCode)). See $AppDataRoot\install-vcredist.log."
            }
            & $PythonExe -c $RuntimeProbe
            if ($LASTEXITCODE -ne 0) {
                throw 'Microsoft Visual C++ x64 runtime DLLs still cannot load. See the import error above and repair the runtime before retrying.'
            }
        }
        finally {
            Remove-Item -LiteralPath $RuntimeInstaller -Force -ErrorAction SilentlyContinue
        }
    }

    foreach ($Environment in @(
        @{ Python = $VenvPython; Path = $VenvRoot; Requirements = (Join-Path $BackendRoot 'requirements.txt') },
        @{ Python = $OrchestratorVenvPython; Path = $OrchestratorVenvRoot; Requirements = (Join-Path $OrchestratorRoot 'requirements.txt') }
    )) {
        if (-not (Test-Path -LiteralPath $Environment.Python -PathType Leaf)) {
            & $PythonExe -m venv $Environment.Path
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Environment.Python -PathType Leaf)) {
                throw "Could not create the Python environment at $($Environment.Path). Expected executable: $($Environment.Python)."
            }
        }
        & $Environment.Python -m pip install --disable-pip-version-check -r $Environment.Requirements
        if ($LASTEXITCODE -ne 0) {
            throw "Could not install dependencies from $($Environment.Requirements)."
        }
    }

    Write-Host 'Checking JuPedSim native simulation in the backend environment...'
    & $VenvPython -c "import jupedsim as jps; sim = jps.Simulation(model=jps.CollisionFreeSpeedModel(), geometry=[(0, 0), (10, 0), (10, 10), (0, 10)]); sim.iterate(); print('JuPedSim native simulation OK')"
    if ($LASTEXITCODE -ne 0) {
        throw 'JuPedSim could not run in the backend environment. See the Python error above; ShopAI installation is not complete.'
    }
}
catch {
    Write-Host "ShopAI dependency installation failed: $($_.Exception.Message)"
    $InstallFailed = $true
}
finally {
    if ($TranscriptStarted) {
        Stop-Transcript | Out-Null
    }
}

if ($InstallFailed) {
    exit 1
}

Set-Content -LiteralPath $CompletionMarker -Value 'complete'
