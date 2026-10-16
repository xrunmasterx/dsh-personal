# Owns the local Personal web process; the original foreground launcher remains available.
[CmdletBinding()]
param([switch]$NoBrowser, [string]$DataHome = (Join-Path $HOME '.dsh-personal'), [int]$Port = 3081)

$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$repo = $base
$node = (Get-Command node -ErrorAction Stop).Source
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
function Test-Ready {
    try { return (Invoke-WebRequest -Uri (Get-OpenUrl) -TimeoutSec 2 -UseBasicParsing -SessionVariable probe).StatusCode -eq 200 }
    catch { return $false } # Startup, shutdown and an unavailable listener are expected here.
}
function Wait-Ready($Process) {
    $deadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-Ready) { return }
        if ($Process.HasExited) { throw "服务启动失败，请查看 $run\server-error.log" }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "服务在 120 秒内未就绪，请查看 $run\server-error.log"
}
function Start-Server {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $Port 已被其他启动方式占用。请先关闭旧服务，再使用一键入口。"
    }
    $env:DSH_HOME = [IO.Path]::GetFullPath($DataHome)
    $env:PATH = (Split-Path -Parent $node) + [IO.Path]::PathSeparator + $env:PATH
    $child = Start-Process -FilePath $node -ArgumentList @('node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'personal', '--host', '127.0.0.1', '--port', $Port, '--no-open') -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'server.log') -RedirectStandardError (Join-Path $run 'server-error.log')
    try { Wait-Ready $child } catch { if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }; throw }
    Write-Status "Ready: server PID $($child.Id)"
    @{id=$child.Id; started=$child.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'server.json')
    return $child
}
function Get-SourceStamp {
    Push-Location $repo
    try { $stamp = & $node scripts/source-stamp.mjs; if ($LASTEXITCODE -ne 0) { throw 'Cannot fingerprint Personal source' }; return $stamp }
    finally { Pop-Location }
}
function Build-Personal {
    Write-Status 'Build started'
    Push-Location $repo
    try {
        & pnpm install --frozen-lockfile *> (Join-Path $run 'install.log')
        if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，请查看 $run/install.log" }
        & $node scripts/build.mjs *> (Join-Path $run 'build.log')
        if ($LASTEXITCODE -ne 0) { throw "构建失败，请查看 $run/build.log" }
        $env:DSH_HOME = [IO.Path]::GetFullPath($DataHome)
        & $node scripts/install.mjs --home $env:DSH_HOME *> (Join-Path $run 'install-profile.log')
        if ($LASTEXITCODE -ne 0) { throw "配置安装失败，请查看 $run/install-profile.log" }
    } finally { Pop-Location }
    Write-Status 'Build passed'
}

function Get-OwnedServer {
    $path = Join-Path $run 'server.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.started).ToUniversalTime().Ticks -and [IO.Path]::GetFullPath($process.Path) -eq [IO.Path]::GetFullPath($node)) { return $process }
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
        return $true
    } catch {
        Write-Status 'Session state unavailable; update deferred'
        return $false
    }
}
function Open-Workbench {
    $server = Get-OwnedServer
    if (-not $server -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { throw "已有其他方式启动的服务占用 $Port，请先关闭旧服务。" }
    $fingerprint = Get-SourceStamp
    $savedPath = Join-Path $run 'built.sha256'
    $saved = if (Test-Path -LiteralPath $savedPath) { (Get-Content -LiteralPath $savedPath -Raw).Trim() } else { '' }
    if ($fingerprint -ne $saved) {
        if ($server -and -not (Test-Idle)) {
            Write-Status 'Update deferred: busy or unknown; opening current version'
        } else {
            try {
                Build-Personal
                if ($fingerprint -ne (Get-SourceStamp)) { throw '构建期间源码有变化，本次不重启。请保存完成后再次打开工作台。' }
                if ($server -and -not (Test-Idle)) {
                    Write-Status 'Update deferred: conversation started during build'
                } else {
                    if ($server) { $server.Kill($true); $server.WaitForExit(); $server = $null }
                    $server = Start-Server
                    Set-Content -LiteralPath $savedPath -Value $fingerprint
                    Write-Status 'Update complete'
                }
            } catch {
                Write-Status $_.Exception.Message
                if (-not $server -or $server.HasExited) { throw }
                Show-Notice $_.Exception.Message | Out-Null
            }
        }
    }
    if (-not $server) { $server = Start-Server }
    if (-not (Test-Ready)) { throw "服务未就绪，请查看 $run\server-error.log" }
    if (-not $NoBrowser) { Start-Process (Get-OpenUrl) }
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
