import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(projectRoot, 'scripts/engine-worker.mjs'));
const digest = createHash('sha256').update(source).digest('hex');
const assetName = `engine-worker.${digest}.js`;
const assetPath = path.join(projectRoot, 'public', assetName);
const browserPath = path.join(projectRoot, 'public/browser.html');
const browser = await readFile(browserPath, 'utf8');
const updatedBrowser = browser.replace(
  /new Worker\(new URL\('\.\/engine-worker\.[a-f0-9]+\.js'/,
  `new Worker(new URL('./${assetName}'`,
);

if (updatedBrowser === browser && !browser.includes(`./${assetName}`)) {
  throw new Error('Could not find the engine Worker asset reference in public/browser.html.');
}

await writeFile(assetPath, source);
if (updatedBrowser !== browser) await writeFile(browserPath, updatedBrowser);
process.stdout.write(`Built ${assetName}\n`);
