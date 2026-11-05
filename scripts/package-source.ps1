param()
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'outputs'
$archivePath = Join-Path $outputDirectory 'kiki-work-assistant-0.1.0-github-source.zip'

# Explicit allowlist: never package .env, .git, node_modules, secrets, or logs.
$included = @(
    'package.json', 'package-lock.json', '.gitignore', '.dockerignore', '.env.example',
    'Dockerfile', 'README.md', 'src', 'scripts', 'migrations', 'test', 'docs'
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $included) {
        $source = Join-Path $projectRoot $relative
        $item = Get-Item -LiteralPath $source
        $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $source -Recurse -File } else { @($item) }
        foreach ($file in $files) {
            $entryName = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
            if ($entryName -match '(^|/)(\.env(?:\..*)?|secrets|node_modules|\.git)(/|$)' -and $entryName -ne '.env.example') {
                throw 'Unexpected private file in package input.'
            }
            if ($entryName -match '\.(log|pem|key|crt|pfx|p12)$') { throw 'Unexpected private file in package input.' }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName) | Out-Null
        }
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
Set-Content -LiteralPath "$archivePath.sha256" -Value "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))" -Encoding ascii
Write-Output $archivePath
Write-Output "$archivePath.sha256"
