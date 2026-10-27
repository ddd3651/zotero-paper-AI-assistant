# Run the CI harness through Zotero's documented Tools > Developer > Run JavaScript.
param([string]$Exe, [string]$Repo, [string]$Evidence, [string]$Root)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SmokeWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
$deadline = (Get-Date).AddSeconds(45)
$window = $null
while ((Get-Date) -lt $deadline) {
    $app = Get-Process zotero -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($app) { $window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle); break }
    Start-Sleep -Seconds 1
}
if (!$window) { throw 'No Zotero UI Automation main window' }
[SmokeWindow]::SetForegroundWindow($app.MainWindowHandle) | Out-Null

try {
    # Zotero's Gecko window may not expose descendants through Windows UIA.
    # Keyboard sequence follows the pinned official Zotero Tools menu order:
    # RTF Scan, Install Connector, Plugins, Developer > Error Console, Run JavaScript.
    [System.Windows.Forms.SendKeys]::SendWait('%t')
    Start-Sleep -Seconds 1
    [System.Windows.Forms.SendKeys]::SendWait('{HOME}{DOWN 3}{RIGHT}')
    Start-Sleep -Seconds 1
    [System.Windows.Forms.SendKeys]::SendWait('{HOME}{DOWN}{ENTER}')
    Start-Sleep -Seconds 2
    $harnessPath = (Join-Path $Repo 'scripts/smoke/harness/bootstrap.js') | ConvertTo-Json -Compress
    $rootJSON = $Root | ConvertTo-Json -Compress
    $code = "var s = {Zotero, Services, IOUtils, PathUtils, ChromeUtils, setTimeout}; Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile($harnessPath)).spec, s); s.run($rootJSON).catch(e => Zotero.logError(e));"
    [System.Windows.Forms.Clipboard]::SetText($code)
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('^r')
    Start-Sleep -Seconds 2
} finally {
    $all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = foreach ($item in $all) { try { @{name=$item.Current.Name; type=$item.Current.ControlType.ProgrammaticName} } catch {} }
    $names | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $Evidence 'ui-tree.json') -Encoding utf8
    [System.Windows.Forms.Clipboard]::Clear()
}
