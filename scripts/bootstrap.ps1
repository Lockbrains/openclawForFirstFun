# FirstClaw Bootstrap Script (Windows PowerShell)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
#
# Ensures Node.js >= 22, pnpm, and project dependencies are installed,
# then builds the project. Works even on machines with NO developer tools.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Resolve project root directory robustly.
# $PSScriptRoot is only set when invoked via -File; when invoked via -Command (e.g. from
# Inno Setup's [Run] section) it is empty. Fall back to $MyInvocation or $PWD.
$_ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } `
              elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } `
              else { $null }

if ($_ScriptDir -and (Test-Path (Join-Path $_ScriptDir ".." "package.json"))) {
    $ProjectRoot = (Resolve-Path (Join-Path $_ScriptDir "..")).Path
} elseif (Test-Path (Join-Path $PWD "package.json")) {
    $ProjectRoot = $PWD.Path
} else {
    Write-Host "[ERR] Cannot find project root (package.json). Run this script from the project directory." -ForegroundColor Red
    exit 1
}

Write-Host "    Project root: $ProjectRoot" -ForegroundColor DarkGray

$MIN_NODE_MAJOR = 22
$NODE_VERSION   = "22.13.0"
$NODE_MSI_URL   = "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-x64.msi"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [ERR] $msg" -ForegroundColor Red }

function Refresh-PathEnv {
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH    = "$userPath;$machinePath"
}

# ---------- 1. Node.js ----------
Write-Step "Checking Node.js ..."

function Test-NodeOk {
    $n = Get-Command node -ErrorAction SilentlyContinue
    if (-not $n) { return $false }
    $v = & node -v 2>$null
    if ($v -match 'v(\d+)') { return ([int]$Matches[1] -ge $MIN_NODE_MAJOR) }
    return $false
}

$nodeOk = Test-NodeOk

if ($nodeOk) {
    $nodeVer = & node -v 2>$null
    Write-Ok "Node.js $nodeVer found"
} else {
    Write-Step "Installing Node.js v${NODE_VERSION} ..."

    $installed = $false

    # --- Method 1: winget (fast, usually no admin needed) ---
    if (-not $installed) {
        $wg = Get-Command winget -ErrorAction SilentlyContinue
        if ($wg) {
            Write-Host "    Trying winget ..."
            & winget install OpenJS.NodeJS.LTS --version $NODE_VERSION `
                --accept-package-agreements --accept-source-agreements `
                --silent 2>$null
            Refresh-PathEnv
            if (Test-NodeOk) { $installed = $true; Write-Ok "Node.js installed via winget" }
        }
    }

    # --- Method 2: Direct MSI download (works on any Windows, may need admin) ---
    if (-not $installed) {
        Write-Host "    Downloading Node.js installer (~30 MB) ..."
        $msiPath = Join-Path $env:TEMP "node-v${NODE_VERSION}-x64.msi"

        try {
            try {
                Start-BitsTransfer -Source $NODE_MSI_URL -Destination $msiPath -ErrorAction Stop
            } catch {
                Invoke-WebRequest -Uri $NODE_MSI_URL -OutFile $msiPath -UseBasicParsing
            }

            Write-Host "    Running Node.js installer (may request admin rights) ..."
            $msiArgs = "/i `"$msiPath`" /qn /norestart"
            $proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
            if ($proc.ExitCode -ne 0) {
                Write-Warn "    Requesting elevated permissions ..."
                $proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru -Verb RunAs
            }
            Remove-Item $msiPath -ErrorAction SilentlyContinue

            Refresh-PathEnv
            $defaultNodeDir = Join-Path $env:ProgramFiles "nodejs"
            if (Test-Path $defaultNodeDir) {
                $env:PATH = "$defaultNodeDir;$env:PATH"
            }

            if (Test-NodeOk) { $installed = $true; Write-Ok "Node.js installed via MSI" }
        } catch {
            Write-Warn "    MSI install failed: $_"
        }
    }

    if (-not $installed) {
        Write-Err "Node.js installation failed."
        Write-Err "Please install manually: https://nodejs.org/"
        Write-Host ""
        Write-Host "Press any key to exit ..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit 1
    }
}

# ---------- 2. pnpm ----------
Write-Step "Checking pnpm ..."

$pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue

if ($pnpmPath) {
    $pnpmVer = & pnpm -v 2>$null
    Write-Ok "pnpm $pnpmVer found"
} else {
    Write-Step "Installing pnpm ..."

    $pnpmInstalled = $false

    # Method 1: corepack (ships with Node >= 22)
    $corepackPath = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepackPath -and -not $pnpmInstalled) {
        Write-Host "    Enabling pnpm via corepack ..."
        try {
            & corepack enable 2>$null
            & corepack prepare pnpm@latest --activate 2>$null
            Refresh-PathEnv
            if (Get-Command pnpm -ErrorAction SilentlyContinue) { $pnpmInstalled = $true }
        } catch {
            Write-Warn "    corepack failed, trying fallback ..."
        }
    }

    # Method 2: standalone installer (no npm required)
    if (-not $pnpmInstalled) {
        Write-Host "    Using pnpm standalone installer ..."
        try {
            Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression
            Refresh-PathEnv
            $pnpmHome = Join-Path $env:LOCALAPPDATA "pnpm"
            if (Test-Path $pnpmHome) { $env:PATH = "$pnpmHome;$env:PATH" }
            if (Get-Command pnpm -ErrorAction SilentlyContinue) { $pnpmInstalled = $true }
        } catch {
            Write-Warn "    Standalone installer failed: $_"
        }
    }

    # Method 3: npm install (if npm is available)
    if (-not $pnpmInstalled) {
        $npmPath = Get-Command npm -ErrorAction SilentlyContinue
        if ($npmPath) {
            Write-Host "    Installing pnpm via npm ..."
            & npm install -g pnpm 2>$null
            Refresh-PathEnv
            if (Get-Command pnpm -ErrorAction SilentlyContinue) { $pnpmInstalled = $true }
        }
    }

    if (-not $pnpmInstalled) {
        Write-Err "pnpm installation failed."
        Write-Err "Please install manually: https://pnpm.io/installation"
        Write-Host ""
        Write-Host "Press any key to exit ..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit 1
    }

    $pnpmVer = & pnpm -v 2>$null
    Write-Ok "pnpm $pnpmVer installed"
}

# ---------- 2b. Disable pnpm auto version switching ----------
# pnpm v10 tries to auto-switch to the version in packageManager field, which can fail
# on Windows due to junction/symlink trust issues ("untrusted mount point").
# Set both the env var (takes effect immediately, before .npmrc is parsed) and .npmrc.
$env:npm_config_manage_package_manager_versions = "false"

$npmrcPath = Join-Path $ProjectRoot ".npmrc"
$npmrcContent = if (Test-Path $npmrcPath) { Get-Content $npmrcPath -Raw } else { "" }
if ($npmrcContent -notmatch "manage-package-manager-versions") {
    Add-Content $npmrcPath "`nmanage-package-manager-versions=false"
    Write-Ok "Disabled pnpm auto version switching (.npmrc + env)"
}

# ---------- 3. Install dependencies ----------
Write-Step "Installing project dependencies (pnpm install) ..."
Write-Host "    This may take a few minutes, please wait ..." -ForegroundColor Yellow

Push-Location $ProjectRoot
try {
    & pnpm install 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    Write-Ok "Dependencies installed"
} finally {
    Pop-Location
}

# ---------- 4. Build ----------
Write-Step "Building project (pnpm build) ..."
Write-Host "    This may take 1-2 minutes ..." -ForegroundColor Yellow

Push-Location $ProjectRoot
try {
    & pnpm build 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
    Write-Ok "Build complete"
} finally {
    Pop-Location
}

# ---------- Done ----------
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  FirstClaw bootstrap complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Run setup wizard:   pnpm firstclaw setup"
Write-Host "  2. Start gateway:      pnpm firstclaw gateway run --force"
Write-Host ""
