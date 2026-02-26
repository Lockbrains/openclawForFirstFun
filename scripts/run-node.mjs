#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();
const compiler = "tsdown";
const compilerArgs = ["exec", compiler, "--no-clean"];

const distRoot = path.join(cwd, "dist");
const distEntry = path.join(distRoot, "/entry.js");
const buildStampPath = path.join(distRoot, ".buildstamp");
const srcRoot = path.join(cwd, "src");
const configFiles = [path.join(cwd, "tsconfig.json"), path.join(cwd, "package.json")];

const statMtime = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath) => {
  const relativePath = path.relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) {
    return false;
  }
  return (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(`test-helpers.ts`)
  );
};

const findLatestMtime = (dirPath, shouldSkip) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const shouldBuild = () => {
  if (env.FIRSTCLAW_FORCE_BUILD === "1") {
    return true;
  }
  const stampMtime = statMtime(buildStampPath);
  if (stampMtime == null) {
    return true;
  }
  if (statMtime(distEntry) == null) {
    return true;
  }

  for (const filePath of configFiles) {
    const mtime = statMtime(filePath);
    if (mtime != null && mtime > stampMtime) {
      return true;
    }
  }

  const srcMtime = findLatestMtime(srcRoot, isExcludedSource);
  if (srcMtime != null && srcMtime > stampMtime) {
    return true;
  }
  return false;
};

const SELF_UPDATE_EXIT_CODE = 42;

const logRunner = (message) => {
  if (env.FIRSTCLAW_RUNNER_LOG === "0") {
    return;
  }
  process.stderr.write(`[firstclaw] ${message}\n`);
};

const writeBuildStamp = () => {
  try {
    fs.mkdirSync(distRoot, { recursive: true });
    fs.writeFileSync(buildStampPath, `${Date.now()}\n`);
  } catch (error) {
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`);
  }
};

const spawnSequence = (steps, onDone) => {
  const next = (i) => {
    if (i >= steps.length) {
      onDone();
      return;
    }
    const { cmd, args: stepArgs, label } = steps[i];
    logRunner(label);
    const proc = spawn(cmd, stepArgs, { cwd, env, stdio: "inherit" });
    proc.on("exit", (code, signal) => {
      if (signal) {
        process.exit(1);
      }
      if (code !== 0 && code !== null) {
        logRunner(`${label} failed with code ${code}`);
        process.exit(code);
      }
      next(i + 1);
    });
  };
  next(0);
};

const pnpmCmd = process.platform === "win32" ? "cmd.exe" : "pnpm";
const pnpmArgs = (subArgs) =>
  process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...subArgs] : subArgs;

const launchNode = () => {
  const nodeProcess = spawn(process.execPath, ["firstclaw.mjs", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  nodeProcess.on("exit", (exitCode, exitSignal) => {
    if (exitCode === SELF_UPDATE_EXIT_CODE) {
      logRunner("Self-update requested; gateway stopped. Running install + build...");
      selfUpdateRebuild();
      return;
    }
    if (exitSignal) {
      process.exit(1);
    }
    process.exit(exitCode ?? 1);
  });
};

const selfUpdateRebuild = () => {
  spawnSequence(
    [
      {
        cmd: pnpmCmd,
        args: pnpmArgs(["install", "--frozen-lockfile"]),
        label: "Installing dependencies...",
      },
      { cmd: pnpmCmd, args: pnpmArgs(["build"]), label: "Building project..." },
    ],
    () => {
      writeBuildStamp();
      logRunner("Self-update rebuild complete; re-launching...");
      launchNode();
    },
  );
};

const startLoop = () => {
  if (!shouldBuild()) {
    launchNode();
  } else {
    logRunner("Building TypeScript (dist is stale).");
    const build = spawn(pnpmCmd, pnpmArgs(compilerArgs), {
      cwd,
      env,
      stdio: "inherit",
    });

    build.on("exit", (code, signal) => {
      if (signal) {
        process.exit(1);
      }
      if (code !== 0 && code !== null) {
        process.exit(code);
      }
      writeBuildStamp();
      launchNode();
    });
  }
};

startLoop();
