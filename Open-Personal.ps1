# Builds isolated releases and owns the local Personal web process.
[CmdletBinding()]
param([switch]$NoBrowser, [string]$DataHome = (Join-Path $HOME '.dsh-personal'), [ValidateRange(1, 65535)][int]$Port = 3081)

$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$repo = $base
$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $node -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 24) { throw 'Personal 需要 Node.js 24 或更新版本。' }
$DataHome = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($DataHome))
$run = Join-Path $base ".local/launcher/$Port"
$url = "http://127.0.0.1:$Port/"
[IO.Directory]::CreateDirectory($run) | Out-Null
$log = Join-Path $run 'launcher.log'
function Write-Status([string]$Text) {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) $Text" -Encoding utf8
}
function Show-Notice([string]$Text) {
    if ($NoBrowser) { Write-Warning $Text; return }
    Add-Type -AssemblyName PresentationFramework
    return [System.Windows.MessageBox]::Show($Text, 'Personal 工作台', 'OK', 'Information')
}
function Get-OpenUrl {
    $output = Join-Path $run 'server.log'
    if (Test-Path -LiteralPath $output) {
        $match = [regex]::Match([string](Get-Content -LiteralPath $output -Raw), ('http://127\.0\.0\.1:' + $Port + '/\?token=[A-Za-z0-9_-]+'))
        if ($match.Success) { return $match.Value }
    }
    return $url
}
function Test-Ready([bool]$RequirePersonal = $false) {
    try {
        if ((Invoke-WebRequest -Uri (Get-OpenUrl) -TimeoutSec 2 -UseBasicParsing -SessionVariable probe).StatusCode -ne 200) { return $false }
        if ($RequirePersonal) { return (Invoke-RestMethod ($url + 'api/personal-workbench.status') -WebSession $probe -TimeoutSec 2).ready -eq $true }
        return $true
    }
    catch { return $false } # Startup, shutdown and an unavailable listener are expected here.
}
function Wait-Ready($Process, [bool]$RequirePersonal) {
    $deadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-Ready $RequirePersonal) { return }
        if ($Process.HasExited) { throw "服务启动失败，请查看 $run\server-error.log" }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "服务在 120 秒内未就绪，请查看 $run\server-error.log"
}
function Start-Server([string]$Runtime) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $Port 已被其他启动方式占用。请先关闭旧服务，再使用一键入口。"
    }
    $env:DSH_HOME = [IO.Path]::GetFullPath($DataHome)
    if (-not $env:PERSONAL_SOURCE_ROOT) { $env:PERSONAL_SOURCE_ROOT = $repo }
    $env:PATH = (Split-Path -Parent $node) + [IO.Path]::PathSeparator + $env:PATH
    $child = Start-Process -FilePath $node -ArgumentList @('node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'personal', '--host', '127.0.0.1', '--port', $Port, '--no-open') -WorkingDirectory $Runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'server.log') -RedirectStandardError (Join-Path $run 'server-error.log')
    try { Wait-Ready $child (Test-Path -LiteralPath (Join-Path $Runtime 'personal-release.json')) } catch { if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }; throw }
    Write-Status "Ready: server PID $($child.Id)"
    @{id=$child.Id; started=$child.StartTime.ToUniversalTime().ToString('o'); home=$DataHome; runtime=$Runtime} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'server.json')
    return $child
}
function Get-SourceStamp {
    Push-Location $repo
    try { $stamp = & $node scripts/source-stamp.mjs; if ($LASTEXITCODE -ne 0) { throw 'Cannot fingerprint Personal source' }; return $stamp }
    finally { Pop-Location }
}
function Build-Personal([string]$Release) {
    Write-Status 'Build started'
    & $node (Join-Path $repo 'scripts/release.mjs') --root $repo --target $Release
    if ($LASTEXITCODE -ne 0) { throw '无法创建独立构建目录。' }
    Push-Location $Release
    try {
        & pnpm install --frozen-lockfile *> (Join-Path $run 'install.log')
        if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，请查看 $run/install.log" }
        & $node scripts/build.mjs *> (Join-Path $run 'build.log')
        if ($LASTEXITCODE -ne 0) { throw "构建失败，请查看 $run/build.log" }
    } finally { Pop-Location }
    Write-Status 'Build passed'
}

function Get-OwnedServer {
    $path = Join-Path $run 'server.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.started).ToUniversalTime().Ticks -and [IO.Path]::GetFullPath($process.Path) -eq [IO.Path]::GetFullPath($node)) {
        if ($record.home -and $record.home -ne $DataHome) { throw "端口 $Port 的服务使用另一个数据目录。请使用另一个端口。" }
        if (-not $record.home -and $DataHome -ne [IO.Path]::GetFullPath((Join-Path $HOME '.dsh-personal'))) { throw '旧启动记录缺少数据目录，无法安全复用。请先关闭该测试服务。' }
        return $process
    }
    return $null
}
function Test-Idle {
    try {
        Invoke-WebRequest -Uri (Get-OpenUrl) -TimeoutSec 5 -SessionVariable auth | Out-Null
        $rpcId = [guid]::NewGuid().ToString()
        $body = @{type='client-request';rpcId=$rpcId;method='session/list';payload=@{args=@{_request=@{}}}} | ConvertTo-Json -Depth 5 -Compress
        $reply = Invoke-RestMethod ($url + 'api/session/list') -Method Post -ContentType application/json -Body $body -WebSession $auth -TimeoutSec 10
        if ($reply.type -ne 'server-response' -or $reply.rpcId -ne $rpcId -or $reply.result.ok -ne $true -or $null -eq $reply.result.value.items) { throw 'Invalid session status response' }
        foreach ($item in $reply.result.value.items) {
            if ($item.running -isnot [bool]) { throw 'Missing session running state' }
            if ($item.running) { return $false }
        }
        try {
            $business = Invoke-RestMethod ($url + 'api/personal-workbench.status') -WebSession $auth -TimeoutSec 5
            if ($business.ready -ne $true -or $business.idle -isnot [bool]) { throw 'Invalid Personal status' }
            if (-not $business.idle) { return $false }
        } catch {
            # Releases before the status route may be upgraded using their native session status.
            if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
        }
        return $true
    } catch {
        Write-Status 'Session state unavailable; update deferred'
        return $false
    }
}
function Open-Workbench {
    $browserOpened = $false
    $server = Get-OwnedServer
    if (-not $server -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { throw "已有其他方式启动的服务占用 $Port，请先关闭旧服务。" }
    $fingerprint = Get-SourceStamp
    $saved = ''
    $installed = Join-Path $DataHome 'personal-installation.json'
    $runtime = if (Test-Path -LiteralPath $installed) { (Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json).source } else { $null }
    if ($runtime) { $runtime = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($runtime)) }
    if ($runtime -and $runtime -ne $repo) {
        $releaseRecord = Join-Path $runtime 'personal-release.json'
        if (-not (Test-Path -LiteralPath $releaseRecord)) { throw '数据目录关联其他源码目录，请先显式重新安装。' }
        $releaseInfo = Get-Content -LiteralPath $releaseRecord -Raw | ConvertFrom-Json
        if ($releaseInfo.source -ne $repo) { throw '数据目录关联其他源码目录，请先显式重新安装。' }
        $saved = $releaseInfo.stamp
    }
    $complete = [bool]$runtime
    if ($complete) {
        & $node (Join-Path $repo 'scripts/runtime.mjs') --root $runtime *> (Join-Path $run 'runtime-check.log')
        $complete = $LASTEXITCODE -eq 0
    }
    if ($fingerprint -ne $saved -or -not $complete) {
        if ($server -and -not (Test-Idle)) {
            Write-Status 'Update deferred: busy or unknown; opening current version'
        } else {
            try {
                $release = Join-Path $run ('release-' + [guid]::NewGuid().ToString('N'))
                Build-Personal $release
                if ($fingerprint -ne (Get-SourceStamp)) { throw '构建期间源码有变化，本次不重启。请保存完成后再次打开工作台。' }
                if ($server -and -not (Test-Idle)) {
                    Write-Status 'Update deferred: conversation started during build'
                } else {
                    $backup = Join-Path $run ('profile-' + [guid]::NewGuid().ToString('N'))
                    if ($server) { $server.Kill($true); $server.WaitForExit(); $server = $null }
                    try {
                        & $node (Join-Path $repo 'scripts/release.mjs') --home $DataHome --backup $backup
                        if ($LASTEXITCODE -ne 0) { throw '无法备份配置，本次未安装更新。' }
                    } catch {
                        if ($complete) { $server = Start-Server $runtime }
                        throw
                    }
                    $previous = $runtime
                    try {
                        & $node (Join-Path $release 'scripts/install.mjs') --home $DataHome *> (Join-Path $run 'install-profile.log')
                        if ($LASTEXITCODE -ne 0) { throw "配置安装失败，请查看 $run/install-profile.log" }
                        $server = Start-Server $release
                        $runtime = $release
                        Write-Status 'Update complete'
                    } catch {
                        $failure = $_
                        if ($server -and -not $server.HasExited) { $server.Kill($true); $server.WaitForExit(); $server = $null }
                        $runtime = $previous
                        & $node (Join-Path $repo 'scripts/release.mjs') --home $DataHome --backup $backup --restore
                        if ($LASTEXITCODE -ne 0) { throw "配置恢复失败，保留了配置备份：$backup" }
                        if ($complete) { $server = Start-Server $runtime; Write-Status 'Previous release restored' }
                        throw $failure
                    }
                    if (-not $NoBrowser) { Start-Process (Get-OpenUrl); $browserOpened = $true }
                    $cleanupArgs = @((Join-Path $repo 'scripts/release.mjs'), '--root', $repo, '--prune', $run, '--keep', $release)
                    if ($previous) { $cleanupArgs += @('--keep', $previous) }
                    & $node @cleanupArgs *> (Join-Path $run 'cleanup.log')
                    if ($LASTEXITCODE -ne 0) { Write-Status 'Obsolete release cleanup deferred; current runtime retained' }
                }
            } catch {
                Write-Status $_.Exception.Message
                if (-not $server -or $server.HasExited) { throw }
                Show-Notice $_.Exception.Message | Out-Null
            }
        }
    }
    if (-not $server) { $server = Start-Server $runtime }
    if (-not (Test-Ready)) { throw "服务未就绪，请查看 $run\server-error.log" }
    if (-not $NoBrowser -and -not $browserOpened) { Start-Process (Get-OpenUrl) }
    Write-Output $url
}
$mutex = [Threading.Mutex]::new($false, "Local\PersonalDSH${Port}Open")
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit } # The first click opens the browser when its update finishes.
    Open-Workbench
} catch { Write-Status $_.Exception.Message; Show-Notice $_.Exception.Message | Out-Null; exit 1 }
finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
