#!/usr/bin/env node
/**
 * Build portable + platform packages for Stream Panel.
 *
 * GitHub Release assets (HARD POLICY — upload ONLY these two):
 *   1. stream-panel_<ver>_amd64.deb          (Linux Debian installer + .desktop menu)
 *   2. StreamPanel-Setup-<ver>.exe           (Windows Inno Setup installer)
 * Do NOT upload zip, tar.gz, source.zip, SHA256SUMS, manifest.json, or other texts to the Release.
 * Use --github-assets so the script emits only those publishable binaries.
 *
 * Local / CI debug outputs under artifacts/release/ (not for GitHub Release):
 *   - stream-panel-<ver>-linux-x64.tar.gz   (portable; omitted with --github-assets)
 *   - stream-panel-<ver>-source.zip         (optional; --source; omit for Release)
 *   - SHA256SUMS + manifest.json            (local verify only; never Release assets)
 *
 * Usage:
 *   node scripts/package-release.mjs [--skip-build] [--skip-runtime] [--source] [--github-assets]
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
/** Emit only GitHub Release binaries: .deb (linux) or Setup .exe (win). No zip/tar/source. */
const githubAssets = args.has("--github-assets");

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
  const appsDir = join(debRoot, "usr", "share", "applications");
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(
    join(appsDir, "stream-panel.desktop"),
    `[Desktop Entry]
Type=Application
Version=1.0
Name=Stream Panel
Name[ru]=Stream Panel
Comment=Local Twitch + DonationAlerts analytics panel
Comment[ru]=Локальная аналитика Twitch + DonationAlerts
Exec=stream-panel
Terminal=false
Categories=Network;AudioVideo;
Keywords=twitch;stream;donations;analytics;
StartupNotify=false
`,
  );
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
 Bundles Node.js ${nodeVersion}. Launches the local UI in your browser.
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

function resolveCscCandidates() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [];
  if (process.env.CSC) candidates.push(process.env.CSC);
  candidates.push("csc");
  candidates.push(
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  );
  candidates.push(
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  );

  const vswhere = join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const found = spawnSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.Component.MSBuild",
        "-find",
        "MSBuild\\**\\Bin\\Roslyn\\csc.exe",
      ],
      { encoding: "utf8" },
    );
    if (found.status === 0 && found.stdout) {
      for (const line of found.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p) candidates.push(p);
      }
    }
  }

  for (const edition of [
    "Enterprise",
    "Professional",
    "Community",
    "BuildTools",
  ]) {
    candidates.push(
      join(
        programFiles,
        "Microsoft Visual Studio",
        "2022",
        edition,
        "MSBuild",
        "Current",
        "Bin",
        "Roslyn",
        "csc.exe",
      ),
    );
  }

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function resolveIsccCandidates() {
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [];
  if (process.env.ISCC) candidates.push(process.env.ISCC);
  candidates.push("ISCC");
  candidates.push(join(programFilesX86, "Inno Setup 6", "ISCC.exe"));
  candidates.push(join(programFiles, "Inno Setup 6", "ISCC.exe"));
  candidates.push(join(programFilesX86, "Inno Setup 5", "ISCC.exe"));
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function buildInnoInstaller({ version, stagingRoot, exeOutPath }) {
  const iss = join(root, "scripts", "installer", "stream-panel.iss");
  if (!existsSync(iss)) throw new Error(`missing ${iss}`);
  const outputDir = dirname(exeOutPath);
  const outputBase = basenameSafe(exeOutPath).replace(/\.exe$/i, "");
  mkdirSync(outputDir, { recursive: true });
  const candidates = resolveIsccCandidates();
  const errors = [];
  for (const iscc of candidates) {
    if (iscc !== "ISCC" && iscc !== process.env.ISCC && !existsSync(iscc)) {
      continue;
    }
    const result = spawnSync(
      iscc,
      [
        `/DAppVersion=${version}`,
        `/DSourceDir=${stagingRoot}`,
        `/DOutputDir=${outputDir}`,
        `/DOutputBase=${outputBase}`,
        iss,
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0 && existsSync(exeOutPath)) {
      console.log("Built Windows installer via", iscc, "->", exeOutPath);
      return exeOutPath;
    }
    const detail = [
      result.error ? result.error.message : null,
      result.stderr && String(result.stderr).trim(),
      result.stdout && String(result.stdout).trim(),
      `exit=${result.status}`,
    ]
      .filter(Boolean)
      .join(" | ");
    errors.push(`${iscc}: ${detail || "failed"}`);
  }
  throw new Error(
    "Failed to build StreamPanel-Setup.exe (Inno Setup ISCC required on Windows packaging).\n" +
      errors.map((e) => `  - ${e}`).join("\n"),
  );
}

function tryBuildWindowsExe(stagingRoot) {
  const cs = join(root, "scripts", "windows-launcher.cs");
  if (!existsSync(cs)) {
    throw new Error(`missing ${cs}`);
  }
  const exePath = join(stagingRoot, "StreamPanel.exe");
  const candidates = resolveCscCandidates();
  const errors = [];
  for (const csc of candidates) {
    if (csc !== "csc" && csc !== process.env.CSC && !existsSync(csc)) {
      continue;
    }
    const result = spawnSync(
      csc,
      ["/nologo", "/optimize", "/t:winexe", `/out:${exePath}`, cs],
      { encoding: "utf8" },
    );
    if (result.status === 0 && existsSync(exePath)) {
      console.log("Built StreamPanel.exe via", csc);
      return exePath;
    }
    const detail = [
      result.error ? result.error.message : null,
      result.stderr && String(result.stderr).trim(),
      result.stdout && String(result.stdout).trim(),
      `exit=${result.status}`,
    ]
      .filter(Boolean)
      .join(" | ");
    errors.push(`${csc}: ${detail || "failed"}`);
  }
  throw new Error(
    "Failed to build StreamPanel.exe (csc required on Windows packaging).\n" +
      errors.map((e) => `  - ${e}`).join("\n"),
  );
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
1. Run Stream Panel (menu / Start Menu / stream-panel / StreamPanel.exe).
2. The local UI opens in your browser automatically (one-time URL).
3. Data stays local (see app docs). Presence minutes ≠ Twitch watch time.

Bundled Node: ${skipRuntime ? "(none)" : nodeVersion}
`,
    );

    const artifacts = [];

    if (platform === "linux") {
      writeLauncherUnix(stagingRoot);
      if (!githubAssets) {
        const tarName = `stream-panel-${version}-linux-${arch}.tar.gz`;
        const tarPath = join(outDir, tarName);
        archiveTarGz(stagingRoot, tarPath);
        artifacts.push(tarPath);
      }
      if (!skipRuntime && existsSync("/usr/bin/dpkg-deb") && arch === "x64") {
        const debPath = join(outDir, `stream-panel_${version}_amd64.deb`);
        buildDeb({ version, stagingRoot, debPath, nodeVersion });
        artifacts.push(debPath);
      } else if (githubAssets) {
        throw new Error(
          "--github-assets on linux requires dpkg-deb and x64 (no .deb produced)",
        );
      }
    } else if (platform === "win32") {
      writeLauncherWindowsCmd(stagingRoot);
      tryBuildWindowsExe(stagingRoot);
      const exeBuilt = join(stagingRoot, "StreamPanel.exe");
      if (!existsSync(exeBuilt)) {
        throw new Error(
          "StreamPanel.exe missing after csc — refusing cmd-only Windows package",
        );
      }
      if (githubAssets) {
        const setupName = `StreamPanel-Setup-${version}.exe`;
        const setupPath = join(outDir, setupName);
        buildInnoInstaller({
          version,
          stagingRoot,
          exeOutPath: setupPath,
        });
        artifacts.push(setupPath);
      } else {
        const zipName = `stream-panel-${version}-win-${arch}.zip`;
        const zipPath = join(outDir, zipName);
        archiveZip(stagingRoot, zipPath);
        artifacts.push(zipPath);
      }
    } else {
      writeLauncherUnix(stagingRoot);
      const tarName = `stream-panel-${version}-${platform}-${arch}.tar.gz`;
      const tarPath = join(outDir, tarName);
      archiveTarGz(stagingRoot, tarPath);
      artifacts.push(tarPath);
    }

    if (wantSource && !githubAssets) {
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

    // Checksums / manifest are for local or CI verification only — never GitHub Release assets.
    writeChecksums(artifacts);
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify(
        {
          version,
          nodeVersion,
          platform,
          arch,
          githubAssets,
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
    if (githubAssets) {
      console.log(
        "GitHub Release policy: upload ONLY the binary artifact(s) above (.deb + StreamPanel-Setup-*.exe). Do not upload zip, tar.gz, source, SHA256SUMS, or manifest.json.",
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
