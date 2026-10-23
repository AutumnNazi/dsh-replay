import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { buildClientBundle } from './bundle.mjs';

const root = new URL('../', import.meta.url);
const { code, names, pkg } = await buildClientBundle();

await mkdir(new URL('lib/', root), { recursive: true });
await writeFile(new URL('lib/client.js', root), code, 'utf8');
for (const [source, target] of [
  ['src/host.js', 'lib/index.js'],
  ['src/components/history.js', 'lib/history-host.js'],
  ['src/components/retry.js', 'lib/retry-host.js'],
]) await copyFile(new URL(source, root), new URL(target, root));
console.log('已生成 lib/client.js（' + names.length + ' 个导出：' + names.join(', ') + '）与 lib/index.js');
