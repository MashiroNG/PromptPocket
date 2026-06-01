param(
  [string]$Version,
  [string]$Repo = 'MashiroNG/PromptPocket',
  [string]$Branch = 'main',
  [string]$ReleaseNotes,
  [switch]$SkipPush,
  [switch]$SkipRelease
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Command not found: $Name"
  }
}

function Resolve-NodeCommand {
  $localNode = Join-Path $root '.tools\node\node.exe'
  if (Test-Path $localNode) {
    return $localNode
  }

  $envNode = $env:PROMPTPOCKET_NODE
  if ($envNode -and (Test-Path $envNode)) {
    return $envNode
  }

  $userNode = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'
  if (Test-Path $userNode) {
    return $userNode
  }

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    return $nodeCommand.Source
  }

  throw 'Node.js was not found. Install Node.js, set PROMPTPOCKET_NODE, or place node.exe at .tools\node\node.exe.'
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $FilePath $($Arguments -join ' ')"
  }
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = Resolve-NodeCommand
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) {
  $fallbackGit = 'C:\Program Files\Git\cmd\git.exe'
  if (Test-Path $fallbackGit) {
    $git = $fallbackGit
  } else {
    throw 'Git was not found. Please install Git first.'
  }
} else {
  $git = $gitCommand.Source
}

Write-Step 'Read and validate version'
$manifest = Get-Content -Raw -Encoding UTF8 'manifest.json' | ConvertFrom-Json
if (-not $Version) {
  $Version = $manifest.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must use x.y.z format. Current value: $Version"
}
if ($manifest.version -ne $Version -or $manifest.version_name -ne $Version) {
  throw "manifest.json version mismatch: version=$($manifest.version), version_name=$($manifest.version_name), target=$Version"
}
$tag = "v$Version"
$zipName = "PromptPocket-v$Version.zip"
$zipPath = Join-Path $root $zipName
Write-Host "Version: $Version"

Write-Step 'Check working tree'
$status = & $git status --porcelain
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to read Git status.'
}
if ($status) {
  throw "Working tree has uncommitted changes. Commit them before releasing.`n$status"
}

Write-Step 'Check JavaScript syntax'
$jsFiles = @(
  'background.js',
  'sidepanel-logic.js',
  'content.js',
  'sidepanel-runtime.js',
  'sidepanel.js',
  'save-selection.js'
)
foreach ($file in $jsFiles) {
  if (-not (Test-Path $file)) {
    throw "Missing file: $file"
  }
  Invoke-Checked -FilePath $node -Arguments @('--check', $file)
}

Write-Step 'Validate Git tag'
$existingLocalTag = & $git tag --list $tag
if ($existingLocalTag) {
  throw "Local tag already exists: $tag"
}
$existingRemoteTag = & $git ls-remote --tags origin $tag
if ($existingRemoteTag) {
  throw "Remote tag already exists: $tag"
}

Write-Step 'Create release zip'
if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Invoke-Checked -FilePath $git -Arguments @('archive', '--format=zip', "--output=$zipPath", 'HEAD')
if (-not (Test-Path $zipPath)) {
  throw "Zip was not created: $zipName"
}
Write-Host "Created: $zipName"

Write-Step 'Create Git tag'
Invoke-Checked -FilePath $git -Arguments @('tag', '-a', $tag, '-m', "PromptPocket $tag")

if (-not $SkipPush) {
  Write-Step 'Push branch and tag'
  Invoke-Checked -FilePath $git -Arguments @('-c', 'http.version=HTTP/1.1', '-c', 'http.sslBackend=schannel', 'push', 'origin', $Branch)
  Invoke-Checked -FilePath $git -Arguments @('-c', 'http.version=HTTP/1.1', '-c', 'http.sslBackend=schannel', 'push', 'origin', $tag)
}

if ($SkipRelease) {
  Write-Step 'Skip GitHub Release'
  Write-Host "Tag: $tag"
  Write-Host "Zip: $zipPath"
  exit 0
}

Write-Step 'Create GitHub Release'
$credentialInput = "protocol=https`nhost=github.com`n`n"
$credentialText = $credentialInput | & $git credential fill
$credential = @{}
foreach ($line in $credentialText) {
  if ($line -match '^(.*?)=(.*)$') {
    $credential[$matches[1]] = $matches[2]
  }
}
$token = $credential['password']
if (-not $token) {
  throw 'No GitHub credential was found in Git Credential Manager.'
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent' = 'PromptPocket-release-script'
}
$changeText = if ($ReleaseNotes) {
  $ReleaseNotes
} else {
  '- Update PromptPocket release package.'
}

$releaseBody = @"
PromptPocket v$Version.

Changes:
$changeText

Install: download $zipName, unzip it, then choose Load unpacked on the Chrome extensions page.
"@
$payloadObject = [ordered]@{
  tag_name = $tag
  target_commitish = $Branch
  name = "PromptPocket $tag"
  body = $releaseBody
  draft = $false
  prerelease = $false
  generate_release_notes = $false
}
$payload = $payloadObject | ConvertTo-Json -Depth 5 -Compress
$payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body $payloadBytes -ContentType 'application/json; charset=utf-8'

Write-Step 'Upload release zip'
$uploadUrl = ($release.upload_url -replace '\{.*$', '') + '?name=' + [uri]::EscapeDataString($zipName)
$asset = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType 'application/zip' -InFile $zipPath

Write-Step 'Release complete'
[pscustomobject]@{
  Version = $Version
  Tag = $tag
  Zip = $zipPath
  ReleaseUrl = $release.html_url
  AssetUrl = $asset.browser_download_url
} | Format-List
