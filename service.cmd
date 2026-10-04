@echo off
setlocal

set "D0=%~dp0"
if "%D0:~-1%"=="\" set "D0=%D0:~0,-1%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$script = [IO.File]::ReadAllText('%~f0', [Text.Encoding]::UTF8); $marker = [char]10 + '###POWERSHELL_START###' + [char]13; if (-not $script.Contains($marker)) { $marker = [char]10 + '###POWERSHELL_START###' }; $code = $script.Substring($script.IndexOf($marker) + $marker.Length); & ([ScriptBlock]::Create($code)) %*"
exit /b %ERRORLEVEL%

###POWERSHELL_START###
param([string]$Action = "")

$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dir = $env:D0
if (-not $dir) { $dir = (Get-Location).Path }
$TaskName = "AntigravityClaudeProxy"

function Show-Header {
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "   Antigravity Claude Proxy Service Management    " -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "Project Directory: $dir" -ForegroundColor Gray
    Write-Host ""
}

function Run-Supervisor {
    Set-Location -LiteralPath $dir
    $nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) { $nodePath = "node.exe" }
    $logPath = Join-Path $dir "service.log"

    while ($true) {
        $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        "[$timestamp] [SERVICE] Starting proxy (node src/index.js)..." | Out-File -FilePath $logPath -Append -Encoding utf8
        & $nodePath "src/index.js" 2>&1 | Out-File -FilePath $logPath -Append -Encoding utf8
        $exitCode = $LASTEXITCODE
        $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        "[$timestamp] [SERVICE] Process exited with code $exitCode. Restarting in 2s..." | Out-File -FilePath $logPath -Append -Encoding utf8
        Start-Sleep -Seconds 2
    }
}

function Install-Service {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "[1/3] Installing service..." -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan

    Write-Host "Stopping existing tasks and processes..." -ForegroundColor Yellow
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*src/index.js*') -or
        ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*service.cmd*run*')
    })
    if ($procs.Count -gt 0) {
        $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Host "Previous processes stopped." -ForegroundColor Gray
    }

    Write-Host "Registering task in Windows Task Scheduler..." -ForegroundColor Cyan
    $serviceCmdPath = Join-Path $dir "service.cmd"
    $psArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$p=''{0}''; $c=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8); $m=[char]10+''###POWERSHELL_START###''+[char]13; if(-not $c.Contains($m)){{$m=[char]10+''###POWERSHELL_START###''}}; $code=$c.Substring($c.IndexOf($m)+$m.Length); & ([ScriptBlock]::Create($code)) run"' -f $serviceCmdPath

    $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgs -WorkingDirectory $dir
    $triggerStartup = New-ScheduledTaskTrigger -AtStartup
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                            -DontStopIfGoingOnBatteries `
                                            -StartWhenAvailable `
                                            -ExecutionTimeLimit (New-TimeSpan -Days 0) `
                                            -RestartInterval (New-TimeSpan -Minutes 1) `
                                            -RestartCount 999 `
                                            -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $TaskName `
                           -Action $taskAction `
                           -Trigger @($triggerStartup, $triggerLogon) `
                           -Principal $principal `
                           -Settings $settings `
                           -Description "Antigravity Claude Proxy background service" | Out-Null

    Write-Host "Service registered successfully in Task Scheduler." -ForegroundColor Green
    Write-Host "Starting service..." -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3

    Get-ServiceStatus
}

function Uninstall-Service {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Yellow
    Write-Host "[2/3] Uninstalling service..." -ForegroundColor Yellow
    Write-Host "==================================================" -ForegroundColor Yellow

    Write-Host "Stopping and removing task from Task Scheduler..." -ForegroundColor Yellow
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

    Write-Host "Terminating background processes..." -ForegroundColor Yellow
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*src/index.js*') -or
        ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*service.cmd*run*')
    })
    if ($procs.Count -gt 0) {
        $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Host ("Stopped processes: " + $procs.Count) -ForegroundColor Green
    } else {
        Write-Host "No running processes found." -ForegroundColor Gray
    }

    Write-Host "Service uninstalled successfully." -ForegroundColor Green
}

function Get-ServiceStatus {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "[3/3] Service Status..." -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "Task Scheduler Task: " -NoNewline
    if ($task) {
        if ($task.State -eq 'Running') {
            Write-Host $task.State -ForegroundColor Green
        } else {
            Write-Host $task.State -ForegroundColor Yellow
        }
    } else {
        Write-Host "NOT INSTALLED" -ForegroundColor Red
    }

    $nodeProcs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*src/index.js*' })
    Write-Host "Node.js Process:     " -NoNewline
    if ($nodeProcs.Count -gt 0) {
        $pids = ($nodeProcs.ProcessId -join ', ')
        Write-Host ("RUNNING, " + $nodeProcs.Count + " instance(s) (PID: " + $pids + ")") -ForegroundColor Green
    } else {
        Write-Host "NOT RUNNING" -ForegroundColor Yellow
    }

    $port = 3023
    $cfgPath = Join-Path $dir "config.json"
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            if ($cfg.port) { $port = [int]$cfg.port }
        } catch {}
    }

    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    Write-Host ("Port " + $port + " (HTTP):        ") -NoNewline
    if ($conn) {
        $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        Write-Host ("LISTENING (PID: " + $conn.OwningProcess + ", " + $p.Name + ")") -ForegroundColor Green
    } else {
        Write-Host "NOT LISTENING" -ForegroundColor Yellow
    }
}

if ($Action) {
    switch ($Action.ToLower()) {
        "run"       { Run-Supervisor; break }
        "install"   { Install-Service; break }
        "1"         { Install-Service; break }
        "uninstall" { Uninstall-Service; break }
        "2"         { Uninstall-Service; break }
        "status"    { Get-ServiceStatus; break }
        "3"         { Get-ServiceStatus; break }
        default {
            Write-Host ("Unknown parameter: " + $Action) -ForegroundColor Red
            Write-Host "Valid parameters: install, uninstall, status (or 1, 2, 3)" -ForegroundColor Yellow
            break
        }
    }
} else {
    do {
        Clear-Host
        Show-Header
        Write-Host "Select an action:" -ForegroundColor White
        Write-Host "  [1] Install Service" -ForegroundColor Green
        Write-Host "  [2] Uninstall Service" -ForegroundColor Red
        Write-Host "  [3] Service Status" -ForegroundColor Yellow
        Write-Host "  [0] Exit" -ForegroundColor Gray
        Write-Host ""
        $choice = Read-Host "Your choice"

        switch ($choice) {
            "1" { Install-Service; Write-Host ""; Read-Host "Press Enter to return to menu..." }
            "2" { Uninstall-Service; Write-Host ""; Read-Host "Press Enter to return to menu..." }
            "3" { Get-ServiceStatus; Write-Host ""; Read-Host "Press Enter to return to menu..." }
            "0" { return }
            default { Write-Host "Invalid choice. Please try again." -ForegroundColor Red; Start-Sleep -Seconds 1 }
        }
    } while ($true)
}
