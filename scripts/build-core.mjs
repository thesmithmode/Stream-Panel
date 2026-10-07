import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
await rm('dist', { recursive: true, force: true });
const child = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
