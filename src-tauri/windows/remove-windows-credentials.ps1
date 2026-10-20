# Removes this app's saved accounts, settings, and Windows sign-ins on uninstall.
# An in-app update does not run this script. The decision procedure is duplicated
# in scripts/windows-uninstall-targets.mjs; change both together.
# Credential blobs are never read. Nothing here is written to the pipeline.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Script:CredFailed = $false

function Test-AppCredentialTarget([string]$Target, $Rules) {
    if ([string]::IsNullOrEmpty($Target) -or $Target.Length -gt [int]$Rules.maxTargetLength) {
        return $false
    }
    if ($Target -match '[\s\x00\\/]') { return $false }
    foreach ($service in @($Rules.credentialServices)) {
        if ($service -notmatch '^[a-z0-9-]+$') { continue }
        $suffix = ".$service"
        if (-not $Target.EndsWith($suffix, [StringComparison]::Ordinal)) { continue }
        $user = $Target.Substring(0, $Target.Length - $suffix.Length)
        if (Test-AppCredentialUser $user $Rules) { return $true }
    }
    return $false
}

function Test-AppCredentialUser([string]$User, $Rules) {
    if ($User.Length -gt 0 -and $User -ceq [string]$Rules.bridgeTokenUser) { return $true }
    $prefix = [string]$Rules.accountUserPrefix
    if ($prefix.Length -eq 0 -or -not $User.StartsWith($prefix, [StringComparison]::Ordinal)) {
        return $false
    }
    $rest = $User.Substring($prefix.Length)
    $accountId = [string]$Rules.accountIdPattern
    $marker = [string]$Rules.chunkMarker
    $chunkAt = -1
    if ($marker.Length -gt 0) { $chunkAt = $rest.IndexOf($marker) }
    if ($chunkAt -lt 0) { return ($rest -cmatch $accountId) }
    $id = $rest.Substring(0, $chunkAt)
    $after = $rest.Substring($chunkAt + $marker.Length)
    $colon = $after.LastIndexOf(":")
    if ($colon -le 0) { return $false }
    $generation = $after.Substring(0, $colon)
    $indexText = $after.Substring($colon + 1)
    if ($id -cnotmatch $accountId) { return $false }
    if ($generation -cnotmatch [string]$Rules.generationPattern) { return $false }
    if ($indexText -notmatch '^[0-9]{1,2}$') { return $false }
    $index = [int]$indexText
    return ($index -ge 0 -and $index -le [int]$Rules.maxChunkIndex)
}

function Test-TempProfileName([string]$Name, $Rules) {
    if ([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 160) { return $false }
    if ($Name.Contains("\") -or $Name.Contains("/") -or $Name.Contains("..") -or $Name.Contains(".")) {
        return $false
    }
    $attemptId = [string]$Rules.attemptIdPattern
    foreach ($prefix in @($Rules.tempProfilePrefixes)) {
        if ($prefix -notmatch '^ai-usage-[a-z]+-$') { continue }
        if (-not $Name.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
        if ($Name.Substring($prefix.Length) -cmatch $attemptId) { return $true }
    }
    return $false
}

# Deletes a directory tree but never follows a junction, symlink, or mount point.
function Remove-TreeContents($Item) {
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    if ($Item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $Item.FullName -Force -ErrorAction SilentlyContinue)) {
            Remove-TreeContents $child
        }
    }
    Remove-Item -LiteralPath $Item.FullName -Force -ErrorAction SilentlyContinue
}

function Remove-BundleDir([string]$Parent, [string]$BundleId) {
    if ([string]::IsNullOrWhiteSpace($Parent)) { return }
    if ($BundleId -notmatch '^[a-z0-9.]+$' -or $BundleId.Contains("..")) { return }
    $parentFull = [IO.Path]::GetFullPath($Parent)
    $candidate = [IO.Path]::GetFullPath((Join-Path $parentFull $BundleId))
    $prefix = $parentFull.TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return }
    $leaf = $candidate.Substring($prefix.Length)
    if ($leaf.Contains('\') -or $leaf.Contains('/')) { return }
    if (-not $leaf.Equals($BundleId, [StringComparison]::OrdinalIgnoreCase)) { return }
    if (-not (Test-Path -LiteralPath $candidate)) { return }
    $item = Get-Item -LiteralPath $candidate -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    if (-not $item.PSIsContainer) { return }
    Remove-TreeContents $item
}

function Remove-TempProfiles([string]$TempDir, $Rules) {
    if ([string]::IsNullOrWhiteSpace($TempDir) -or -not (Test-Path -LiteralPath $TempDir)) { return }
    $tempFull = [IO.Path]::GetFullPath($TempDir)
    $tempPrefix = $tempFull.TrimEnd('\') + '\'
    foreach ($entry in @(Get-ChildItem -LiteralPath $tempFull -Force -ErrorAction SilentlyContinue)) {
        if (-not (Test-TempProfileName $entry.Name $Rules)) { continue }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if (-not $entry.PSIsContainer) { continue }
        $full = [IO.Path]::GetFullPath($entry.FullName)
        if (-not $full.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($full.Substring($tempPrefix.Length).Contains('\')) { continue }
        Remove-TreeContents $entry
    }
}

# CREDENTIALW.Type is a DWORD at offset 4. TargetName is the next pointer, at
# offset 8 on both 32-bit and 64-bit (two DWORDs, then a pointer). Only generic
# credentials (type 1) are considered, and the secret blob is not read.
function Get-GenericCredentialTargets {
    $count = 0
    $pointer = [IntPtr]::Zero
    $ok = [AiUsageTracker.CredentialCleanup]::EnumerateAll([ref]$count, [ref]$pointer)
    if (-not $ok) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 1168) { return @() } # ERROR_NOT_FOUND
        throw "credential list failed"
    }
    try {
        $names = New-Object System.Collections.Generic.List[string]
        $pointerSize = [IntPtr]::Size
        for ($i = 0; $i -lt $count; $i++) {
            $credential = [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, $i * $pointerSize)
            if ($credential -eq [IntPtr]::Zero) { continue }
            $type = [Runtime.InteropServices.Marshal]::ReadInt32($credential, 4)
            if ($type -ne 1) { continue }
            $namePointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($credential, 8)
            if ($namePointer -eq [IntPtr]::Zero) { continue }
            $name = [Runtime.InteropServices.Marshal]::PtrToStringUni($namePointer)
            if (-not [string]::IsNullOrEmpty($name)) { $names.Add($name) }
        }
        return $names
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [AiUsageTracker.CredentialCleanup]::CredFree($pointer)
        }
    }
}

if (-not ("AiUsageTracker.CredentialCleanup" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace AiUsageTracker {
    public static class CredentialCleanup {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr credentials);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredDelete(string target, int type, int flags);
        [DllImport("advapi32.dll")]
        public static extern void CredFree(IntPtr buffer);

        public static bool EnumerateAll(out int count, out IntPtr credentials) {
            return CredEnumerate(null, 0, out count, out credentials);
        }
    }
}
"@
}

function Remove-AppCredentials($Rules) {
    $names = @(Get-GenericCredentialTargets)
    foreach ($name in $names) {
        if (-not (Test-AppCredentialTarget $name $Rules)) { continue }
        $deleted = [AiUsageTracker.CredentialCleanup]::CredDelete($name, 1, 0)
        if (-not $deleted) {
            $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($errorCode -ne 1168) { $Script:CredFailed = $true }
        }
    }
}

$rules = Get-Content -LiteralPath (Join-Path $PSScriptRoot "uninstall-rules.json") -Raw | ConvertFrom-Json
try { Remove-AppCredentials $rules } catch { $Script:CredFailed = $true }
Remove-BundleDir $env:APPDATA $rules.bundleId
Remove-BundleDir $env:LOCALAPPDATA $rules.bundleId
Remove-TempProfiles $env:TEMP $rules
if ($Script:CredFailed) { exit 2 }
exit 0
