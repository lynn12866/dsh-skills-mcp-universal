import { Script } from 'node:vm';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [
  'dist/client.js',
  ...(await readdir(join(root, 'dist/src')))
    .filter((name) => name.endsWith('.js'))
    .map((name) => 'dist/src/' + name),
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const file of [
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
])
  await readFile(join(root, file));
if (!manifest.dsh?.engines && !manifest.engines?.dsh)
  throw new Error('DSH compatibility range is required.');
console.log(`Checked ${files.length} JavaScript modules and package resources.`);

new Script(await readFile(join(root, 'dist/client.js'), 'utf8'));
