import { createServer } from 'vite';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import electron from 'electron';

let child;
let server;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child?.kill();
  await server?.close();
  process.exitCode = code;
}
try {
  await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    external: ['electron', 'pdfjs-dist/*'], sourcemap: true });
  server = await createServer();
  await server.listen();
  const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, ['.'], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error); void stop(1); });
  child.on('exit', code => void stop(code ?? 0));
  console.log('Renderer hot-reloads. Restart npm run dev after changing electron/ or shared/.');
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch (error) { console.error(error); await stop(1); }
