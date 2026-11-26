#requires -Version 7.0
param([switch]$CheckOnly,[switch]$BuildOnly)
$ErrorActionPreference='Stop'
if (!$env:TOOL_ACCEPTANCE_ROOT) { throw 'Task-owned TOOL_ACCEPTANCE_ROOT required.' }
$env:POMODORO_TOOL_TEST_ROOT=Join-Path $env:TOOL_ACCEPTANCE_ROOT 'controller-tests'
[void][IO.Directory]::CreateDirectory($env:POMODORO_TOOL_TEST_ROOT)
if ($BuildOnly) {
    & node scripts/tauri.mjs build --no-bundle --config '{"build":{"beforeBuildCommand":""}}'
    exit $LASTEXITCODE
}
& npm.cmd run build:frontend
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& node scripts/cargo.mjs fmt -- --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& node scripts/cargo.mjs test
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if (!$CheckOnly) {
    & node scripts/tauri.mjs build --no-bundle
    exit $LASTEXITCODE
}
