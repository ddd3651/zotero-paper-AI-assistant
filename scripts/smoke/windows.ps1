$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$root = Join-Path $env:RUNNER_TEMP "paper-chat 中文 & 100% ! 'smoke"
$evidence = Join-Path $repo 'dist/smoke-evidence'
New-Item -ItemType Directory -Force $root, $evidence | Out-Null
$url = 'https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6_win-x64.zip'
$zip = Join-Path $root 'zotero.zip'
$proc = $null
try {
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $root 'application')
    $exe = (Get-ChildItem -LiteralPath (Join-Path $root 'application') -Filter zotero.exe -Recurse | Select-Object -First 1).FullName
    if (!$exe) { throw 'Official ZIP did not contain zotero.exe' }
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    @{ source=$url; sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash;
       signatureStatus=[string]$signature.Status; signer=$signature.SignerCertificate.Subject;
       os=[System.Environment]::OSVersion.VersionString; interactive=[Environment]::UserInteractive } |
       ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'environment.json') -Encoding utf8
    if ($signature.Status -ne 'Valid') { throw "Official executable signature validation failed: $($signature.Status)" }
    python scripts/smoke/prepare.py $root $repo
    if ($LASTEXITCODE -ne 0) { throw 'Profile preparation failed' }
    $env:PAPER_CHAT_CODEX = Join-Path $repo 'scripts/smoke/mock-codex.mjs'
    $profile = Join-Path $root 'profile'
    $proc = Start-Process -FilePath $exe -ArgumentList @('-no-remote','-profile',('"' + $profile + '"'),'-purgecaches','-ZoteroDebugText') -PassThru -RedirectStandardOutput (Join-Path $root 'stdout.txt') -RedirectStandardError (Join-Path $root 'stderr.txt')
    Start-Sleep -Seconds 15
    & (Join-Path $repo 'scripts/smoke/drive-ui.ps1') -Exe $exe -Repo $repo -Evidence $evidence -Root $root
    $deadline = (Get-Date).AddSeconds(180)
    $resultFile = Join-Path $root 'result.json'
    $result = $null
    $lastAction = 0
    $started = Get-Date
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-Path -LiteralPath $resultFile) {
            try { $result = Get-Content -Raw -LiteralPath $resultFile | ConvertFrom-Json } catch { continue }
            if ($result.success -or $result.error) { break }
            if ($result.action -and $result.action.id -ne $lastAction) {
                $a = $result.action
                if ($a.type -notin @('send-question','click')) { throw 'Unsupported test input action' }
                $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
                if ($a.x -lt 0 -or $a.y -lt 0 -or $a.x -ge $screen.Width -or $a.y -ge $screen.Height) { throw 'Test control is outside visible desktop' }
                $zoteroIds = @(Get-Process zotero -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Select-Object -ExpandProperty Id)
                $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                $target = $windows | Where-Object { $_.Current.ProcessId -in $zoteroIds -and $_.Current.Name -like '*Zotero*' } | Select-Object -First 1
                $main = if ($target) { [IntPtr]$target.Current.NativeWindowHandle } else { [IntPtr]::Zero }
                if ($main -eq [IntPtr]::Zero) { throw 'Synthetic Zotero window not found' }
                [SmokeWindow]::SetForegroundWindow($main) | Out-Null
                Start-Sleep -Milliseconds 250
                if ([SmokeWindow]::GetForegroundWindow() -ne $main) { throw 'Synthetic Zotero window did not acquire native focus' }
                [SmokeWindow]::SetCursorPos(10, 10) | Out-Null
                Start-Sleep -Milliseconds 150
                [SmokeWindow]::mouse_event(0x8001, [uint32]($a.x * 65535 / ($screen.Width - 1)), [uint32]($a.y * 65535 / ($screen.Height - 1)), 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 150
                [SmokeWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
                Start-Sleep -Milliseconds 120
                [SmokeWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
                if ($a.type -eq 'send-question') { [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}') }
                @{id=$a.id;type=$a.type;x=$a.x;y=$a.y} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $evidence 'native-actions.jsonl')
                $lastAction = $a.id
            }
        }
        if (!$result -and ((Get-Date) - $started).TotalSeconds -gt 30) { throw 'Developer script did not create its initial result within 30 seconds' }
        # Zotero may hand off to a child process and return zero from its launcher.
        if ($proc.HasExited -and $proc.ExitCode -ne 0) { throw "Zotero launcher failed: $($proc.ExitCode)" }
    }
    if (!$result) { throw 'Zotero started but CI harness produced no result within 180 seconds' }
    if (!$result.success) { throw "Zotero smoke failed: $($result.error); completed checks: $($result.checks -join ', ')" }
} catch {
    @{ error=[string]$_; processExited=($proc -and $proc.HasExited) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'host-error.json') -Encoding utf8
    throw
} finally {
    $extensions = Join-Path $root 'profile/extensions.json'
    if (Test-Path -LiteralPath $extensions) { Copy-Item -LiteralPath $extensions -Destination (Join-Path $evidence 'extensions.json') }
    if (Test-Path -LiteralPath (Join-Path $root 'result.json')) { Copy-Item -LiteralPath (Join-Path $root 'result.json') -Destination $evidence }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $evidence 'desktop.png'))
        $graphics.Dispose(); $bitmap.Dispose()
    } catch { [string]$_ | Set-Content -LiteralPath (Join-Path $evidence 'screenshot-error.txt') }
    $config = Get-Content -Raw -LiteralPath (Join-Path $repo 'bridge/config.json') | ConvertFrom-Json
    foreach ($name in @('stdout.txt','stderr.txt')) {
        $path = Join-Path $root $name
        if (Test-Path -LiteralPath $path) {
            ([string](Get-Content -Raw -LiteralPath $path)).Replace($config.token, '[REDACTED TEST TOKEN]') | Set-Content -LiteralPath (Join-Path $evidence $name) -Encoding utf8
        }
    }
    Get-Process zotero -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
    # Only this ephemeral VM's bridge is addressed, with its generated local token.
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/shutdown" -Method Post -Headers @{Authorization="Bearer $($config.token)"} -ContentType 'application/json' -Body '{}' | Out-Null } catch {}
}
