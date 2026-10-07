#!/usr/bin/env node
/**
 * Build portable + platform packages for Stream Panel.
 *
 * Outputs under artifacts/release/:
 *   - stream-panel-<ver>-linux-x64.tar.gz   (portable)
 *   - stream-panel_<ver>_amd64.deb          (Linux; when dpkg-deb available)
 *   - stream-panel-<ver>-win-x64.zip        (portable; Windows runner)
 *   - StreamPanel.exe inside the win zip   (when csc available)
 *   - stream-panel-<ver>-source.zip        (optional; --source)
 *
 * Usage:
 *   node scripts/package-release.mjs [--skip-build] [--skip-runtime] [--source]
 * Env:
 *   STREAM_PANEL_VERSION  override package.json version
 *   STREAM_PANEL_NODE_VERSION  override bundled Node (default: .node-version)
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "artifacts", "release");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const skipRuntime = args.has("--skip-runtime");
const wantSource = args.has("--source");

function readVersion() {
  if (process.env.STREAM_PANEL_VERSION) return process.env.STREAM_PANEL_VERSION;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return String(pkg.version || "0.0.0");
}

function readNodeVersion() {
  return (
    process.env.STREAM_PANEL_NODE_VERSION ||
    readFileSync(join(root, ".node-version"), "utf8").trim()
  );
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0)
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${result.status})`);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

function writeLauncherUnix(stagingRoot) {
  const path = join(stagingRoot, "stream-panel");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$ROOT/runtime/bin:$PATH"
cd "$ROOT/app"
exec "$ROOT/runtime/bin/node" dist/apps/daemon/src/index.js "$@"
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

function writeLauncherWindowsCmd(stagingRoot) {
  writeFileSync(
    join(stagingRoot, "StreamPanel.cmd"),
    `@echo off
setlocal
set ROOT=%~dp0
set PATH=%ROOT%runtime;%PATH%
cd /d "%ROOT%app"
"%ROOT%runtime\\node.exe" dist\\apps\\daemon\\src\\index.js %*
`,
  );
}

async function fetchNodeRuntime(nodeVersion, platform, arch, destDir) {
  mkdirSync(destDir, { recursive: true });
  const isWin = platform === "win32";
  const nodeArch = arch === "arm64" ? "arm64" : "x64";
  const slug = isWin
    ? `node-v${nodeVersion}-win-${nodeArch}`
    : `node-v${nodeVersion}-${platform === "darwin" ? "darwin" : "linux"}-${nodeArch}`;
  const ext = isWin ? "zip" : "tar.gz";
  const url = `https://nodejs.org/dist/v${nodeVersion}/${slug}.${ext}`;
  const archive = join(destDir, `${slug}.${ext}`);
  console.log(`Downloading Node ${nodeVersion} (${slug})…`);
  await download(url, archive);
  const extractDir = join(destDir, "extracted");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  if (isWin) {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    run("tar", ["-xzf", archive, "-C", extractDir]);
  }
  const nested = join(extractDir, slug);
  const runtimeDir = join(destDir, "runtime");
  rmSync(runtimeDir, { recursive: true, force: true });
  if (isWin) {
    mkdirSync(runtimeDir, { recursive: true });
    copyFileSync(join(nested, "node.exe"), join(runtimeDir, "node.exe"));
  } else {
    mkdirSync(join(runtimeDir, "bin"), { recursive: true });
    copyFileSync(join(nested, "bin", "node"), join(runtimeDir, "bin", "node"));
    chmodSync(join(runtimeDir, "bin", "node"), 0o755);
  }
  rmSync(archive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  return runtimeDir;
}

function stageApp(stagingApp) {
  rmSync(stagingApp, { recursive: true, force: true });
  mkdirSync(stagingApp, { recursive: true });
  cpSync(join(root, "dist"), join(stagingApp, "dist"), { recursive: true });
  // Drop tests from the shipped tree — keep runtime only.
  for (const rel of [
    "dist/packages/core/test",
    "dist/apps/daemon/test",
    "dist/scripts",
  ]) {
    rmSync(join(stagingApp, rel), { recursive: true, force: true });
  }
  // Static UI: server resolves ../../../../apps/web/dist from dist/apps/daemon/src.
  const webDist = join(root, "apps", "web", "dist");
  if (!existsSync(webDist))
    throw new Error("apps/web/dist missing — run pnpm build:web");
  mkdirSync(join(stagingApp, "apps", "web"), { recursive: true });
  cpSync(webDist, join(stagingApp, "apps", "web", "dist"), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(
    join(stagingApp, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        private: true,
        type: "module",
        engines: pkg.engines,
        dependencies: pkg.dependencies,
        scripts: { start: "node dist/apps/daemon/src/index.js" },
      },
      null,
      2,
    ),
  );
  console.log("Installing production dependencies into staging…");
  // Flat package (no workspace): npm resolves pinned versions from package.json.
  run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], {
    cwd: stagingApp,
  });
  rmSync(join(stagingApp, "package-lock.json"), { force: true });
}

function archiveTarGz(srcDir, destFile) {
  mkdirSync(dirname(destFile), { recursive: true });
  run("tar", ["-czf", destFile, "-C", dirname(srcDir), basenameSafe(srcDir)]);
}

function basenameSafe(p) {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop();
}

function archiveZip(srcDir, destFile) {
  mkdirSync(dirname(destFile), { recursive: true });
  rmSync(destFile, { force: true });
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${join(srcDir, "*").replace(/'/g, "''")}' -DestinationPath '${destFile.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    run("zip", ["-r", "-q", destFile, basenameSafe(srcDir)], {
      cwd: dirname(srcDir),
    });
  }
}

function buildDeb({ version, stagingRoot, debPath, nodeVersion }) {
  const debRoot = join(outDir, "deb-root");
  rmSync(debRoot, { recursive: true, force: true });
  const opt = join(debRoot, "opt", "stream-panel");
  mkdirSync(opt, { recursive: true });
  cpSync(stagingRoot, opt, { recursive: true });
  const binDir = join(debRoot, "usr", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "stream-panel"),
    `#!/usr/bin/env bash
set -euo pipefail
exec /opt/stream-panel/stream-panel "$@"
`,
    { mode: 0o755 },
  );
  chmodSync(join(binDir, "stream-panel"), 0o755);
  const debian = join(debRoot, "DEBIAN");
  mkdirSync(debian, { recursive: true });
  const sizeKb = Math.max(
    1,
    Number(
      spawnSync("du", ["-sk", debRoot], { encoding: "utf8" }).stdout.split(
        /\s+/,
      )[0],
    ) || 1,
  );
  writeFileSync(
    join(debian, "control"),
    `Package: stream-panel
Version: ${version}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Stream Panel <noreply@localhost>
Installed-Size: ${sizeKb}
Depends: libc6
Homepage: https://github.com/thesmithmode/Stream-Panel
Description: Local Twitch + DonationAlerts analytics panel
 Stream Panel stores chat, donations, sessions and presence locally.
 Bundles Node.js ${nodeVersion}. Opens a localhost UI after start.
`,
  );
  writeFileSync(
    join(debian, "postinst"),
    `#!/bin/sh
set -e
chmod 755 /opt/stream-panel/stream-panel /usr/bin/stream-panel || true
chmod 755 /opt/stream-panel/runtime/bin/node || true
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(join(debian, "postinst"), 0o755);
  run("dpkg-deb", ["--build", "--root-owner-group", debRoot, debPath]);
  rmSync(debRoot, { recursive: true, force: true });
}

function tryBuildWindowsExe(stagingRoot) {
  const cs = join(root, "scripts", "windows-launcher.cs");
  if (!existsSync(cs)) return null;
  const exePath = join(stagingRoot, "StreamPanel.exe");
  // Prefer csc from .NET Framework / Build Tools
  const candidates = [
    process.env.CSC,
    "csc",
    join(
      process.env["WINDIR"] || "C:\\\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    ),
  ].filter(Boolean);
  for (const csc of candidates) {
    const result = spawnSync(
      csc,
      ["/nologo", "/optimize", `/out:${exePath}`, cs],
      { encoding: "utf8" },
    );
    if (result.status === 0 && existsSync(exePath)) {
      console.log("Built StreamPanel.exe via", csc);
      return exePath;
    }
  }
  console.warn(
    "csc not available — shipping StreamPanel.cmd only (CI windows-latest builds .exe).",
  );
  return null;
}

function writeChecksums(files) {
  const lines = files.map((f) => `${sha256File(f)}  ${basenameSafe(f)}`);
  writeFileSync(join(outDir, "SHA256SUMS"), lines.join("\n") + "\n");
}

async function main() {
  const version = readVersion();
  const nodeVersion = readNodeVersion();
  const platform = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  console.log(`Packaging Stream Panel ${version} for ${platform}-${arch}`);
  mkdirSync(outDir, { recursive: true });

  if (!skipBuild) {
    run("pnpm", ["build"]);
  }
  if (!existsSync(join(root, "dist", "apps", "daemon", "src", "index.js")))
    throw new Error("dist missing — run pnpm build first");

  const work = mkdtempSync(join(tmpdir(), "sp-pkg-"));
  try {
    const stagingRoot = join(work, `stream-panel-${version}`);
    mkdirSync(stagingRoot, { recursive: true });
    const stagingApp = join(stagingRoot, "app");
    stageApp(stagingApp);

    if (!skipRuntime) {
      const runtimeParent = join(work, "node-fetch");
      const runtimeDir = await fetchNodeRuntime(
        nodeVersion,
        platform,
        arch,
        runtimeParent,
      );
      cpSync(runtimeDir, join(stagingRoot, "runtime"), { recursive: true });
    } else {
      mkdirSync(join(stagingRoot, "runtime"), { recursive: true });
      writeFileSync(
        join(stagingRoot, "runtime", "README.txt"),
        "Runtime skipped (--skip-runtime). Use system Node 24.19+.\n",
      );
    }

    writeFileSync(
      join(stagingRoot, "README.txt"),
      `Stream Panel ${version}
=================
1. Run the launcher (stream-panel / StreamPanel.exe / StreamPanel.cmd).
2. Open the one-time URL printed in the terminal.
3. Data stays local (see app docs). Presence minutes ≠ Twitch watch time.

Bundled Node: ${skipRuntime ? "(none)" : nodeVersion}
`,
    );

    const artifacts = [];

    if (platform === "linux") {
      writeLauncherUnix(stagingRoot);
      const tarName = `stream-panel-${version}-linux-${arch}.tar.gz`;
      const tarPath = join(outDir, tarName);
      archiveTarGz(stagingRoot, tarPath);
      artifacts.push(tarPath);
      if (!skipRuntime && existsSync("/usr/bin/dpkg-deb") && arch === "x64") {
        const debPath = join(outDir, `stream-panel_${version}_amd64.deb`);
        buildDeb({ version, stagingRoot, debPath, nodeVersion });
        artifacts.push(debPath);
      }
    } else if (platform === "win32") {
      writeLauncherWindowsCmd(stagingRoot);
      tryBuildWindowsExe(stagingRoot);
      const zipName = `stream-panel-${version}-win-${arch}.zip`;
      const zipPath = join(outDir, zipName);
      archiveZip(stagingRoot, zipPath);
      artifacts.push(zipPath);
    } else {
      writeLauncherUnix(stagingRoot);
      const tarName = `stream-panel-${version}-${platform}-${arch}.tar.gz`;
      const tarPath = join(outDir, tarName);
      archiveTarGz(stagingRoot, tarPath);
      artifacts.push(tarPath);
    }

    if (wantSource) {
      const sourceZip = join(outDir, `stream-panel-${version}-source.zip`);
      rmSync(sourceZip, { force: true });
      run(
        "git",
        [
          "archive",
          "--format=zip",
          `--output=${sourceZip}`,
          `--prefix=stream-panel-${version}/`,
          "HEAD",
        ],
        { cwd: root },
      );
      artifacts.push(sourceZip);
    }

    writeChecksums(artifacts);
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify(
        {
          version,
          nodeVersion,
          platform,
          arch,
          createdAt: new Date().toISOString(),
          artifacts: artifacts.map((f) => ({
            file: basenameSafe(f),
            sha256: sha256File(f),
            bytes: readFileSync(f).byteLength,
          })),
        },
        null,
        2,
      ),
    );
    console.log("Artifacts:");
    for (const f of artifacts) console.log(" -", f);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
