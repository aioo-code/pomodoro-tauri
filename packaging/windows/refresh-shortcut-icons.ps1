#requires -Version 5.1
param(
 [Parameter(Mandatory=$true)][string]$InstallDirectory,
 [Parameter(Mandatory=$true)][string]$IconPath,
 [string]$ShortcutDirectory=''
)
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskRoot=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$taskIcon=[IO.Path]::GetFullPath($IconPath)
if(!$taskIcon.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $taskIcon -PathType Leaf)){throw 'The installed version icon is required.'}
$taskExe=[IO.Path]::GetFullPath((Join-Path $taskRoot 'pomodoro-connected.exe'))
$taskLauncher=[IO.Path]::GetFullPath((Join-Path $taskRoot 'start.ps1'))
$taskPaths=if($ShortcutDirectory){@((Join-Path $ShortcutDirectory 'Desktop.lnk'),(Join-Path $ShortcutDirectory 'Programs.lnk'))}else{
 @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) '番茄时钟.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) '番茄时钟.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) '番茄时钟/番茄时钟.lnk'))
}
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class PomodoroShortcutNotify {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint evt,uint flags,string path,IntPtr other);
}
'@
$taskShell=New-Object -ComObject WScript.Shell
$taskChanged=@();$taskSkipped=@()
foreach($taskPath in $taskPaths){
 if(!(Test-Path -LiteralPath $taskPath -PathType Leaf)){continue}
 if((Get-Item -LiteralPath $taskPath).Attributes -band [IO.FileAttributes]::ReparsePoint){$taskSkipped+=@{path=$taskPath;reason='linked file'};continue}
 $taskLink=$taskShell.CreateShortcut($taskPath)
 $taskOwnTarget=$taskLink.TargetPath -and ([IO.Path]::GetFullPath($taskLink.TargetPath) -eq $taskExe)
 $taskOwnLauncher=([IO.Path]::GetFileName($taskLink.TargetPath) -in @('powershell.exe','pwsh.exe')) -and ($taskLink.Arguments.IndexOf($taskLauncher,[StringComparison]::OrdinalIgnoreCase) -ge 0)
 if(!$taskOwnTarget -and !$taskOwnLauncher){$taskSkipped+=@{path=$taskPath;reason='other target'};continue}
 $taskOldIcon=$taskLink.IconLocation
 $taskOldPath=$taskOldIcon
 $taskComma=$taskOldIcon.LastIndexOf(',');if($taskComma -ge 0){$taskOldPath=$taskOldIcon.Substring(0,$taskComma)}
 $taskOldPath=$taskOldPath.Trim('"')
 $taskManaged=(!$taskOldPath) -or ($taskOldPath -eq $taskExe) -or ($taskOldPath -eq [IO.Path]::GetFullPath((Join-Path $taskRoot 'icons/flow.ico'))) -or ($taskOldPath.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($taskOldPath) -like 'pomodoro-app-icon-*.ico')
 if(!$taskManaged){$taskSkipped+=@{path=$taskPath;reason='custom icon retained'};continue}
 if($taskOldIcon -eq ($taskIcon+',0')){continue}
 $taskBefore=@{target=$taskLink.TargetPath;args=$taskLink.Arguments;working=$taskLink.WorkingDirectory}
 $taskLink.IconLocation=$taskIcon+',0';$taskLink.Save()
 $taskRead=$taskShell.CreateShortcut($taskPath)
 if($taskRead.TargetPath -ne $taskBefore.target -or $taskRead.Arguments -ne $taskBefore.args -or $taskRead.WorkingDirectory -ne $taskBefore.working){throw 'Shortcut launch details changed unexpectedly.'}
 [PomodoroShortcutNotify]::SHChangeNotify(0x2000,0x2005,$taskPath,[IntPtr]::Zero)
 $taskChanged+=@{path=$taskPath;before=$taskOldIcon;after=$taskRead.IconLocation;target=$taskRead.TargetPath;args=$taskRead.Arguments}
}
@{changed=@($taskChanged);skipped=@($taskSkipped);icon=$taskIcon;globalCacheDeleted=$false;explorerRestarted=$false}|ConvertTo-Json -Depth 5 -Compress
