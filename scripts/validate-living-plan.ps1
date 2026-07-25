[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
$lines = [System.IO.File]::ReadAllLines($resolvedPath)
$errors = [System.Collections.Generic.List[string]]::new()
$tasks = @{}
$ordered = [System.Collections.Generic.List[object]]::new()
$statuses = @('Pending', 'Blocked', 'Ready', 'Active', 'Complete')

if (-not ($lines -match '^## Execution$')) {
    $errors.Add("Missing ## Execution.")
}
if (-not ($lines -match '^- Mode: (Supervised|Continuous)$')) {
    $errors.Add("Execution mode is missing or invalid.")
}
if (-not ($lines -match '^- Task execution: (Inline|Separate threads)$')) {
    $errors.Add("Task execution is missing or invalid.")
}

$rowPattern = '^\|\s*(?<id>[A-Za-z][A-Za-z0-9._-]*)\s*\|\s*(?<parent>[^|]+?)\s*\|\s*(?<outcome>[^|]+?)\s*\|\s*(?<depends>[^|]+?)\s*\|\s*(?<status>[^|]+?)\s*\|$'
foreach ($line in $lines) {
    if ($line -notmatch $rowPattern -or $Matches.id -eq 'ID') {
        continue
    }
    $id = $Matches.id.Trim()
    if ($tasks.ContainsKey($id)) {
        $errors.Add("Duplicate task $id.")
        continue
    }
    $task = [pscustomobject]@{
        Id = $id
        Parent = $Matches.parent.Trim()
        Depends = @($Matches.depends.Trim() -split '\s*,\s*' | Where-Object { $_ -ne 'None' })
        Status = $Matches.status.Trim()
    }
    if ($statuses -notcontains $task.Status) {
        $errors.Add("Task $id has invalid status '$($task.Status)'.")
    }
    $tasks[$id] = $task
    $ordered.Add($task)
}

if ($ordered.Count -eq 0) {
    $errors.Add("Task ledger has no rows.")
}
if (@($ordered | Where-Object Status -eq 'Active').Count -gt 1) {
    $errors.Add("More than one task is Active.")
}

foreach ($task in $ordered) {
    if ($task.Parent -ne 'None' -and -not $tasks.ContainsKey($task.Parent)) {
        $errors.Add("Task $($task.Id) has missing parent $($task.Parent).")
    }
    foreach ($dependency in $task.Depends) {
        if (-not $tasks.ContainsKey($dependency)) {
            $errors.Add("Task $($task.Id) has missing dependency $dependency.")
        }
        elseif ($task.Status -in @('Ready', 'Active', 'Complete') -and $tasks[$dependency].Status -ne 'Complete') {
            $errors.Add("$($task.Status) task $($task.Id) depends on incomplete $dependency.")
        }
    }
}

foreach ($parent in $ordered) {
    $children = @($ordered | Where-Object Parent -eq $parent.Id)
    if ($children.Count -eq 0) {
        continue
    }
    if ($parent.Status -in @('Ready', 'Active')) {
        $errors.Add("Parent task $($parent.Id) cannot be $($parent.Status).")
    }
    if ($parent.Status -eq 'Complete' -and @($children | Where-Object Status -ne 'Complete').Count) {
        $errors.Add("Complete parent task $($parent.Id) has incomplete children.")
    }
}

$validationStart = [Array]::IndexOf($lines, '## Validation log')
foreach ($task in $ordered | Where-Object Status -eq 'Complete') {
    if (@($ordered | Where-Object Parent -eq $task.Id).Count) {
        continue
    }
    $pattern = '^- ' + [regex]::Escape($task.Id) + ':\s+\S'
    if ($validationStart -lt 0 -or -not ($lines[($validationStart + 1)..($lines.Count - 1)] -match $pattern)) {
        $errors.Add("Complete leaf task $($task.Id) has no validation evidence.")
    }
}

if ($errors.Count) {
    $errors | ForEach-Object { [Console]::Error.WriteLine("ERROR: $_") }
    throw "Living plan validation failed with $($errors.Count) error(s)."
}

Write-Output "VALID: '$resolvedPath' ($($ordered.Count) tasks)."
