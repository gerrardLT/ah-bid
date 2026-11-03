#Requires -Version 5.1
<#
.SYNOPSIS
    Resource preflight before heavy tasks: free memory, top processes, disk headroom.

.DESCRIPTION
    Cheap by default (no directory walk). Pass -Path to measure a folder size.
    Gate: peak memory > 50% of free RAM, or single-run writes > max(5 GB, 20% of free).
    Keep output ASCII-only: Windows PowerShell 5.1 mis-decodes BOM-less UTF-8 source.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\resource-preflight.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\resource-preflight.ps1 -Path data\attachments
#>
param(
    [string]$Path = "",
    [int]$Top = 5
)

$ErrorActionPreference = "Stop"

$os = Get-CimInstance -ClassName Win32_OperatingSystem
$totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$usedPct = if ($totalGB -gt 0) { [math]::Round((($totalGB - $freeGB) / $totalGB) * 100, 1) } else { 0 }

Write-Output "== MEMORY =="
Write-Output ("Total {0} GB | Free {1} GB | Used {2}%" -f $totalGB, $freeGB, $usedPct)
Write-Output ("Peak budget: {0} GB (50% of free RAM)" -f [math]::Round($freeGB * 0.5, 1))

Write-Output ""
Write-Output "== TOP PROCESSES (by working set) =="
Get-Process |
    Sort-Object -Property WorkingSet64 -Descending |
    Select-Object -First $Top Name, Id, @{ n = "MemMB"; e = { [math]::Round($_.WorkingSet64 / 1MB) } } |
    Format-Table -AutoSize |
    Out-String -Width 120 |
    Write-Output

Write-Output "== DISK =="
Get-PSDrive -PSProvider FileSystem |
    Where-Object { $null -ne $_.Used -and $null -ne $_.Free } |
    ForEach-Object {
        $size = $_.Used + $_.Free
        [pscustomobject]@{
            Drive   = $_.Name
            FreeGB  = [math]::Round($_.Free / 1GB, 1)
            TotalGB = [math]::Round($size / 1GB, 1)
            FreePct = if ($size -gt 0) { [math]::Round($_.Free / $size * 100, 1) } else { 0 }
        }
    } |
    Format-Table -AutoSize |
    Out-String -Width 120 |
    Write-Output

$writeBudget = $null
try {
    $root = [System.IO.Path]::GetPathRoot((Get-Location).Path)
    $workDrive = Get-PSDrive -Name $root.Substring(0, 1) -PSProvider FileSystem -ErrorAction Stop
    $writeBudget = [math]::Max(5, [math]::Round($workDrive.Free / 1GB * 0.2, 1))
    Write-Output ("Write budget: {0} GB for one run on drive {1} (max of 5 GB and 20% free)" -f $writeBudget, $workDrive.Name)
} catch {
    Write-Output "Write budget: max of 5 GB and 20% of free disk space"
}

if ($Path) {
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Write-Output ""
        Write-Output ("Path not found: {0}" -f $Path)
        exit 1
    }

    Write-Output ""
    Write-Output "== PATH SIZE (recursive, may be slow on large trees) =="
    $m = Get-ChildItem -LiteralPath $resolved -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    $sizeGB = [math]::Round(($m.Sum / 1GB), 2)
    Write-Output ("{0} = {1} GB, {2} files" -f $Path, $sizeGB, $m.Count)
    Write-Output ("If loaded at once -> text/csv/json ~ {0} GB | excel ~ {1} GB | pdf by page ~ O(pages x 50 MB)" -f `
            [math]::Round($sizeGB * 4, 1), [math]::Round($sizeGB * 20, 1))
}

Write-Output ""
Write-Output "== GATE =="
Write-Output "High load when: peak memory > peak budget, OR single-run writes > write budget."
Write-Output "High load -> report estimate to user first, or switch to streaming/chunked code (AGENTS.md R1-R4)."
