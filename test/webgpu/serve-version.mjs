// Serve the exact same sources against a separately installed Three.js package.
// Example: THREE_ROOT=/tmp/gtvbao-r185/node_modules/three PORT=5193 node test/webgpu/serve-version.mjs
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const threeRoot = resolve(process.env.THREE_ROOT || resolve(root, 'node_modules/three'));
const { version } = JSON.parse(await readFile(resolve(threeRoot, 'package.json'), 'utf8'));
const server = await createServer({
  root,
  configFile: false,
  cacheDir: resolve(tmpdir(), `gtvbao-three-${version}-${process.pid}`),
  resolve: {
    alias: [
      { find: /^three\/addons\//, replacement: `${threeRoot}/examples/jsm/` },
      { find: /^three\/webgpu$/, replacement: `${threeRoot}/build/three.webgpu.js` },
      { find: /^three\/tsl$/, replacement: `${threeRoot}/build/three.tsl.js` },
      { find: /^three$/, replacement: `${threeRoot}/build/three.module.js` },
      { find: /^three\//, replacement: `${threeRoot}/` },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT || 5193),
    strictPort: true,
    fs: { allow: [root, threeRoot] },
  },
});
await server.listen();
console.log(`Three.js ${version}: ${threeRoot}`);
server.printUrls();
