$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Form = New-Object System.Windows.Forms.Form
$Form.Text = 'Configure ShopAI LLM'
$Form.Size = New-Object System.Drawing.Size(460, 280)
$Form.StartPosition = 'CenterScreen'
$Form.FormBorderStyle = 'FixedDialog'
$Form.MaximizeBox = $false
$Form.MinimizeBox = $false

$ProviderLabel = New-Object System.Windows.Forms.Label
$ProviderLabel.Text = 'LLM provider'
$ProviderLabel.Location = New-Object System.Drawing.Point(20, 20)
$ProviderLabel.AutoSize = $true
$Form.Controls.Add($ProviderLabel)

$ProviderBox = New-Object System.Windows.Forms.ComboBox
$ProviderBox.DropDownStyle = 'DropDownList'
$ProviderBox.Items.AddRange([string[]]@('OpenAI', 'Anthropic', 'xAI', 'OpenRouter', 'None (deterministic)'))
$ProviderBox.SelectedIndex = 0
$ProviderBox.Location = New-Object System.Drawing.Point(20, 45)
$ProviderBox.Size = New-Object System.Drawing.Size(400, 28)
$Form.Controls.Add($ProviderBox)

$InfoLabel = New-Object System.Windows.Forms.Label
$InfoLabel.Text = 'Your API key is encrypted for this Windows account and never included in logs.'
$InfoLabel.Location = New-Object System.Drawing.Point(20, 82)
$InfoLabel.Size = New-Object System.Drawing.Size(400, 36)
$Form.Controls.Add($InfoLabel)

$KeyLabel = New-Object System.Windows.Forms.Label
$KeyLabel.Text = 'Provider API key'
$KeyLabel.Location = New-Object System.Drawing.Point(20, 127)
$KeyLabel.AutoSize = $true
$Form.Controls.Add($KeyLabel)

$KeyBox = New-Object System.Windows.Forms.TextBox
$KeyBox.UseSystemPasswordChar = $true
$KeyBox.Location = New-Object System.Drawing.Point(20, 152)
$KeyBox.Size = New-Object System.Drawing.Size(400, 24)
$Form.Controls.Add($KeyBox)

$SaveButton = New-Object System.Windows.Forms.Button
$SaveButton.Text = 'Save and launch'
$SaveButton.Location = New-Object System.Drawing.Point(214, 195)
$SaveButton.Size = New-Object System.Drawing.Size(110, 30)
$SaveButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$Form.Controls.Add($SaveButton)

$CancelButton = New-Object System.Windows.Forms.Button
$CancelButton.Text = 'Cancel'
$CancelButton.Location = New-Object System.Drawing.Point(334, 195)
$CancelButton.Size = New-Object System.Drawing.Size(86, 30)
$CancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$Form.Controls.Add($CancelButton)
$Form.AcceptButton = $SaveButton
$Form.CancelButton = $CancelButton

if ($Form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 0
}

$Provider = switch ($ProviderBox.SelectedIndex) {
    0 { 'openai' }
    1 { 'anthropic' }
    2 { 'xai' }
    3 { 'openrouter' }
    default { 'none' }
}
$ApiKey = $KeyBox.Text.Trim()
if ($Provider -ne 'none' -and -not $ApiKey) {
    [System.Windows.Forms.MessageBox]::Show(
        'Enter an API key for the selected provider, or choose deterministic mode.',
        'ShopAI',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    exit 1
}

$ConfigRoot = Join-Path $env:LOCALAPPDATA 'ShopAI'
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
$SecureKey = ConvertTo-SecureString -String $ApiKey -AsPlainText -Force
$Settings = @{
    provider = $Provider
    protectedApiKey = ConvertFrom-SecureString -SecureString $SecureKey
}
$Settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ConfigRoot 'llm-settings.json') -Encoding UTF8
$KeyBox.Clear()
$SecureKey.Dispose()

& (Join-Path $PSScriptRoot 'stop-shopai.ps1')
$Launcher = Join-Path $PSScriptRoot 'launch-shopai.ps1'
Start-Process -FilePath 'powershell.exe' `
    -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`"" `
    -WindowStyle Hidden
