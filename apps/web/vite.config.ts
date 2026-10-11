import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import {execFileSync} from 'node:child_process';
const release=process.env.STREAM_PANEL_RELEASE??process.env.GITHUB_SHA??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
export default defineConfig({
  define:{__STREAM_PANEL_RELEASE__:JSON.stringify(release)},
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
