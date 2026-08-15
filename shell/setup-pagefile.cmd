@echo off
:: Sets a RAM-scaled pagefile (1.5x RAM, clamped 16-64 GB) on the fixed drive with the most free space.
:: Must be run as Administrator, will auto-elevate if needed

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ============================================
echo   Vek-Snap: Pagefile Setup
echo ============================================
echo.
echo   Auto-detecting RAM and target drive...
echo.
echo   This prevents OOM crashes during AI generation.
echo.

:: Auto-detect RAM + target drive, then set a fixed pagefile (single elevated PowerShell block).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ramGB=[int][math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB); $pfGB=[int][math]::Min([math]::Max([math]::Ceiling($ramGB*1.5),16),64); $d=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Sort-Object FreeSpace -Descending | Select-Object -First 1; $freeGB=[int]($d.FreeSpace/1GB); $cap=[math]::Max($freeGB-10,4); if($pfGB -gt $cap){$pfGB=$cap}; $sizeMB=[uint32]($pfGB*1024); $name=$d.DeviceID + '\pagefile.sys'; Write-Host ('  Detected RAM : {0} GB' -f $ramGB); Write-Host ('  Target drive : {0} ({1} GB free)' -f $d.DeviceID,$freeGB); Write-Host ('  Pagefile     : {0} ({1} GB fixed)' -f $name,$pfGB); Set-CimInstance -Query 'SELECT * FROM Win32_ComputerSystem' -Property @{AutomaticManagedPagefile=$false}; Get-CimInstance Win32_PageFileSetting | Remove-CimInstance -ErrorAction SilentlyContinue; New-CimInstance -ClassName Win32_PageFileSetting -Property @{Name=$name; InitialSize=$sizeMB; MaximumSize=$sizeMB} | Out-Null"

echo.
echo   Done! Pagefile will be active after reboot.
echo.
echo   To verify after reboot, run:
echo     systeminfo ^| findstr "Page"
echo.
pause
