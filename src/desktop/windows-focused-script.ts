/** Fixed read-only program, never model-generated PowerShell. Runs only inside
 * the runtime-owned hidden worker. No write/input, clipboard, screenshot,
 * network, recursive filesystem scan or arbitrary command operation exists. */
export const WINDOWS_FOCUSED_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AgentOfficeWindowProbe {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  public static uint Owner(IntPtr h) {uint p;GetWindowThreadProcessId(h,out p);return p;}
  public static string Title(IntPtr h) {var s=new StringBuilder(512);GetWindowText(h,s,512);return s.ToString();}
}
'@
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    if ($line.Length -gt 8192) {throw 'INPUT_LIMIT'}
    $request = $line | ConvertFrom-Json
    if ($request.op -ne 'read') {throw 'READ_ONLY'}
    $handle = [IntPtr]([long]$request.window_id)
    if (-not [AgentOfficeWindowProbe]::IsWindow($handle) -or [AgentOfficeWindowProbe]::Owner($handle) -ne [uint32]$request.pid) {throw 'WINDOW_CHANGED'}
    $title = [AgentOfficeWindowProbe]::Title($handle)
    if ($title -cne $request.window_title) {throw 'WINDOW_CHANGED'}
    $process = [System.Diagnostics.Process]::GetProcessById([int]$request.pid)
    $app = $process.ProcessName + '.exe'
    if ($app -ine $request.app_name) {throw 'WINDOW_CHANGED'}
    if (-not [AgentOfficeWindowProbe]::IsWindowVisible($handle) -or [AgentOfficeWindowProbe]::IsIconic($handle) -or -not [AgentOfficeWindowProbe]::IsWindowEnabled($handle)) {throw 'WINDOW_BLOCKED'}
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $role = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
    $name = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$request.label)
    $condition = New-Object System.Windows.Automation.AndCondition($role,$name)
    # Native provider search by two exact properties; no tree rendering or
    # per-control value fetch. Duplicates remain visible, never choose first.
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
    if ($matches.Count -ne 1) {throw 'TARGET_NOT_UNIQUE'}
    $element = $matches.Item(0)
    $current = $element.Current
    if ($current.ProcessId -ne [int]$request.pid -or $current.IsPassword) {throw 'TARGET_FORBIDDEN'}
    if ($null -ne $request.automation_id -and $current.AutomationId -cne $request.automation_id) {throw 'LOCATOR_CHANGED'}
    if ($null -ne $request.class_name -and $current.ClassName -cne $request.class_name) {throw 'LOCATOR_CHANGED'}
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -or $pattern.Current.IsReadOnly) {throw 'NOT_SETTABLE'}
    $value = $pattern.Current.Value
    if ($null -ne $value -and $value.Length -gt 8000) {throw 'VALUE_LIMIT'}
    $bounds = $current.BoundingRectangle
    $rootBounds = $root.Current.BoundingRectangle
    if (-not [AgentOfficeWindowProbe]::IsWindowEnabled($handle) -or [AgentOfficeWindowProbe]::Owner($handle) -ne [uint32]$request.pid) {throw 'WINDOW_CHANGED'}
    $result = @{
      id=$request.id;ok=$true;pid=[int]$request.pid;window_id=[long]$request.window_id;app_name=$app;window_title=$title;
      process_started_ticks=$process.StartTime.ToUniversalTime().Ticks.ToString();
      field=@{label=$current.Name;automation_id=$current.AutomationId;class_name=$current.ClassName;role='Edit';
        runtime_id=([string]::Join('.', $element.GetRuntimeId()));value=$value;enabled=$current.IsEnabled;visible=(-not $current.IsOffscreen);
        frame=@{x=$bounds.X;y=$bounds.Y;w=$bounds.Width;h=$bounds.Height}};
      window_bounds=@{x=$rootBounds.X;y=$rootBounds.Y;width=$rootBounds.Width;height=$rootBounds.Height}
    }
    [Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 7))
  } catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^[A-Z_]{1,50}$') {$code='READ_UNAVAILABLE'}
    [Console]::WriteLine((@{id=$request.id;ok=$false;code=$code} | ConvertTo-Json -Compress))
  }
}
`;
