#requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$Operation,
    [string]$ParamsJson='{}',
    [string]$RequestId=([Guid]::NewGuid().ToString('N')),
    [Nullable[UInt64]]$ExpectedRevision,
    [switch]$Qa,
    [string]$Executable=(Join-Path $PSScriptRoot '../src-tauri/target/release/pomodoro-connected.exe')
)
$ErrorActionPreference='Stop'
$parameters=$ParamsJson|ConvertFrom-Json -AsHashtable
$request=@{schema='cosy.tool.request/1';id=$RequestId;operation=$Operation;params=$parameters}
if ($null -ne $ExpectedRevision) { $request.expected_revision=$ExpectedRevision }
$start=[Diagnostics.ProcessStartInfo]::new([IO.Path]::GetFullPath($Executable))
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
$start.ArgumentList.Add('--tool-request')
$start.ArgumentList.Add(($request|ConvertTo-Json -Compress -Depth 30))
if ($Qa) { $start.ArgumentList.Add('--tool-qa') }
$process=[Diagnostics.Process]::Start($start)
$output=$process.StandardOutput.ReadToEnd()
$errorOutput=$process.StandardError.ReadToEnd()
$process.WaitForExit()
$output.TrimEnd()
if ($errorOutput) { [Console]::Error.WriteLine($errorOutput.TrimEnd()) }
exit $process.ExitCode
