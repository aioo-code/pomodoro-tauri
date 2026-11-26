param([Parameter(Mandatory)][int]$OwnedProcessId, [Parameter(Mandatory)][int]$ExpectedWidth, [Parameter(Mandatory)][int]$ExpectedHeight, [Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expectedExe = Join-Path $taskRoot 'src-tauri/target/release/pomodoro-compact.exe'
$ownedProcess = Get-Process -Id $OwnedProcessId
if ($ownedProcess.Path -ne $expectedExe) { throw 'Capture is limited to the exact project QA executable.' }
$outputAbsolute = [IO.Path]::GetFullPath($OutputPath)
$evidenceRoot = Join-Path $taskRoot 'artifacts/v0.5.0/'
if (-not $outputAbsolute.StartsWith($evidenceRoot.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Capture output must stay inside this version evidence directory.' }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PomodoroGlassCapture {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, uint attribute, out Rect r, uint size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr insert, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MonitorInfo info);
  public static IntPtr FindOwnedMain(uint pid, int width, int height) {
    IntPtr best = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); Rect r;
      if (p == pid && GetWindowRect(h, out r)) {
        StringBuilder title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
        if (title.ToString().Contains("\u756a\u8304\u65f6\u949f") && Math.Abs(r.Right-r.Left-width)<=1 && Math.Abs(r.Bottom-r.Top-height)<=1) best = h;
      }
      return true; }, IntPtr.Zero);
    return best;
  }
  public static bool ShowCenteredWithoutActivation(IntPtr h) {
    Rect r; if (!GetWindowRect(h, out r)) return false;
    MonitorInfo m = new MonitorInfo(); m.Size = Marshal.SizeOf(m);
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) return false;
    int x=m.Work.Left + (m.Work.Right-m.Work.Left-(r.Right-r.Left))/2;
    int y=m.Work.Top + (m.Work.Bottom-m.Work.Top-(r.Bottom-r.Top))/2;
    return SetWindowPos(h, new IntPtr(-1), x, y, 0, 0, 0x0010 | 0x0001 | 0x0040);
  }
  public static void Hide(IntPtr h) { SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0010 | 0x0001 | 0x0002 | 0x0080); }
}
'@
$previousDpiContext = [PomodoroGlassCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
$ownedWindow = [PomodoroGlassCapture]::FindOwnedMain([uint32]$OwnedProcessId, $ExpectedWidth, $ExpectedHeight)
if ($ownedWindow -eq [IntPtr]::Zero) { throw 'Owned QA main window was not found.' }
try {
  if (-not [PomodoroGlassCapture]::ShowCenteredWithoutActivation($ownedWindow)) { throw 'Could not present QA main window without activation.' }
  Start-Sleep -Milliseconds 400
  [uint32]$foregroundProcess = 0
  [void][PomodoroGlassCapture]::GetWindowThreadProcessId([PomodoroGlassCapture]::GetForegroundWindow(), [ref]$foregroundProcess)
  if ($foregroundProcess -eq [uint32]$OwnedProcessId) { throw 'QA presentation activated the application.' }
  $bounds = New-Object PomodoroGlassCapture+Rect
  if (-not [PomodoroGlassCapture]::GetWindowRect($ownedWindow, [ref]$bounds)) { throw 'Cannot read owned window bounds.' }
  if ([Math]::Abs($bounds.Right-$bounds.Left-$ExpectedWidth) -gt 1 -or [Math]::Abs($bounds.Bottom-$bounds.Top-$ExpectedHeight) -gt 1) { throw 'Owned window bounds changed; refusing capture.' }
  $visibleBounds = New-Object PomodoroGlassCapture+Rect
  if ([PomodoroGlassCapture]::DwmGetWindowAttribute($ownedWindow, 9, [ref]$visibleBounds, 16) -lt 0) { throw 'Cannot read the visible DWM frame; refusing capture.' }
  if ($visibleBounds.Left -lt $bounds.Left -or $visibleBounds.Top -lt $bounds.Top -or $visibleBounds.Right -gt $bounds.Right -or $visibleBounds.Bottom -gt $bounds.Bottom -or $visibleBounds.Right -le $visibleBounds.Left -or $visibleBounds.Bottom -le $visibleBounds.Top) { throw 'Visible DWM frame is outside verified bounds; refusing capture.' }
  $bounds = $visibleBounds
  $bitmap = New-Object Drawing.Bitmap (($bounds.Right-$bounds.Left), ($bounds.Bottom-$bounds.Top))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($outputAbsolute, [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  @{ processId=$OwnedProcessId; activated=$false; path=$outputAbsolute; width=($bounds.Right-$bounds.Left); height=($bounds.Bottom-$bounds.Top) } | ConvertTo-Json -Compress
} finally { [PomodoroGlassCapture]::Hide($ownedWindow); [void][PomodoroGlassCapture]::SetThreadDpiAwarenessContext($previousDpiContext) }
