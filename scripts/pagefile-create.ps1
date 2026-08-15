# pagefile-create.ps1
# Creates or extends a Windows page file at runtime using the undocumented
# NtCreatePagingFile API from ntdll.dll. This bypasses the normal reboot
# requirement for page file changes.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File pagefile-create.ps1 `
#     -DriveLetter "D" -MinSizeMB 8192 -MaxSizeMB 16384
#
# Requires: Administrator privileges + SeCreatePagefilePrivilege
# Safety:   Can only CREATE new or EXTEND existing page files.
#           Cannot shrink or remove: the kernel rejects such requests.

param(
    [Parameter(Mandatory=$true)]
    [string]$DriveLetter,

    [Parameter(Mandatory=$true)]
    [long]$MinSizeMB,

    [Parameter(Mandatory=$true)]
    [long]$MaxSizeMB
)

$ErrorActionPreference = "Stop"

# Validate inputs
if ($DriveLetter.Length -ne 1 -or $DriveLetter -notmatch '^[A-Za-z]$') {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Invalid drive letter: $DriveLetter" })
    exit 1
}

if ($MinSizeMB -lt 1024) {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Minimum size must be at least 1024 MB (1 GB)" })
    exit 1
}

if ($MaxSizeMB -lt $MinSizeMB) {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Maximum size must be >= minimum size" })
    exit 1
}

# Check that the drive exists and has enough free space
$drive = Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue
if (-not $drive) {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Drive ${DriveLetter}: not found" })
    exit 1
}

$freeSpaceMB = [math]::Floor($drive.Free / 1MB)
if ($MaxSizeMB -gt ($freeSpaceMB * 0.75)) {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Max size ($MaxSizeMB MB) exceeds 75% of free space ($freeSpaceMB MB) on ${DriveLetter}:" })
    exit 1
}

# P/Invoke definitions for NtCreatePagingFile
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class NtPageFile
{
    [StructLayout(LayoutKind.Sequential)]
    public struct UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("ntdll.dll", SetLastError = false)]
    public static extern int RtlAdjustPrivilege(
        int Privilege, bool Enable, bool CurrentThread, out bool WasEnabled);

    [DllImport("ntdll.dll", SetLastError = false)]
    public static extern int NtCreatePagingFile(
        ref UNICODE_STRING PageFileName,
        ref long MinimumSize,
        ref long MaximumSize,
        out long ActualSize);

    [DllImport("ntdll.dll", SetLastError = false)]
    public static extern void RtlInitUnicodeString(
        ref UNICODE_STRING DestinationString,
        [MarshalAs(UnmanagedType.LPWStr)] string SourceString);

    public static int CreatePageFile(string ntPath, long minBytes, long maxBytes)
    {
        // Enable SeCreatePagefilePrivilege (privilege #15)
        bool wasEnabled;
        int privResult = RtlAdjustPrivilege(15, true, false, out wasEnabled);
        if (privResult != 0)
            return privResult;

        try
        {
            UNICODE_STRING fileName = new UNICODE_STRING();
            RtlInitUnicodeString(ref fileName, ntPath);

            long actualSize;
            return NtCreatePagingFile(ref fileName, ref minBytes, ref maxBytes, out actualSize);
        }
        finally
        {
            // Restore original privilege state
            if (!wasEnabled)
            {
                bool ignored;
                RtlAdjustPrivilege(15, false, false, out ignored);
            }
        }
    }
}
"@

# Convert to NT path format and bytes
$ntPath = "\??\${DriveLetter}:\pagefile.sys"
$minBytes = $MinSizeMB * 1MB
$maxBytes = $MaxSizeMB * 1MB

try {
    $result = [NtPageFile]::CreatePageFile($ntPath, $minBytes, $maxBytes)

    if ($result -eq 0) {
        # STATUS_SUCCESS
        Write-Output (ConvertTo-Json @{
            success = $true
            message = "Page file created/extended on ${DriveLetter}: (${MinSizeMB} - ${MaxSizeMB} MB)"
            drive = $DriveLetter
            minMB = $MinSizeMB
            maxMB = $MaxSizeMB
        })
    } else {
        $hex = "0x{0:X8}" -f $result
        $errorMsg = switch ($result) {
            0xC0000061 { "Privilege not held (SeCreatePagefilePrivilege). Run as Administrator." }
            0xC00000F0 { "Too many paging files (max 16). Remove one first." }
            0xC00000EF { "Invalid parameter: file may already exist with larger size (cannot shrink)." }
            0xC000009A { "Insufficient resources: not enough disk space or memory." }
            default    { "NtCreatePagingFile returned NTSTATUS $hex" }
        }
        Write-Output (ConvertTo-Json @{ success = $false; error = $errorMsg; ntstatus = $hex })
        exit 1
    }
} catch {
    Write-Output (ConvertTo-Json @{ success = $false; error = $_.Exception.Message })
    exit 1
}
