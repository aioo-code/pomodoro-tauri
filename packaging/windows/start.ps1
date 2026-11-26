#requires -Version 7.0
param([switch]$Inspect,[string]$DataDirectory)
$ErrorActionPreference='Stop'
$exe=Join-Path $PSScriptRoot 'pomodoro-connected.exe'
$receipt=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'delivery.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ine $receipt.sha256) { throw '程序与已验收的构建不一致，请重新核对交付文件。' }
$running=@(Get-Process pomodoro-connected -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($exe) })
if ($DataDirectory -and ![IO.Path]::IsPathFullyQualified($DataDirectory)) { throw '应用数据目录必须使用绝对路径。' }
if ($Inspect) { @{executable=$exe;sha256=$receipt.sha256;dataDirectory=$DataDirectory;existingTimer=@($running | ForEach-Object { $_.Id })} | ConvertTo-Json; return }
if ($running) { throw '已有番茄时钟运行，请先从原程序的托盘退出，再启动。' }
$start=[Diagnostics.ProcessStartInfo]::new($exe)
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.WorkingDirectory=$PSScriptRoot
if ($DataDirectory) { $start.ArgumentList.Add('--tool-data-dir='+[IO.Path]::GetFullPath($DataDirectory)) }
[Diagnostics.Process]::Start($start) | Select-Object Id,ProcessName
