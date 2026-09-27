import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const adapterSource = await readFile(path.join(projectRoot, 'scripts/worker-adapter.mjs'));
const adapterDigest = createHash('sha256').update(adapterSource).digest('hex');
const adapterName = `worker-adapter.${adapterDigest}.mjs`;
await writeFile(path.join(projectRoot, 'public', adapterName), adapterSource);

const workerEntry = await readFile(path.join(projectRoot, 'scripts/engine-worker.mjs'), 'utf8');
const workerSource = workerEntry.replace(
  /from (['"])\.\/worker-adapter(?:\.[a-f0-9]+)?\.mjs\1/,
  `from './${adapterName}'`,
);
if (workerSource === workerEntry && !workerEntry.includes(`./${adapterName}`)) {
  throw new Error('Could not find the Worker adapter import in scripts/engine-worker.mjs.');
}
const workerDigest = createHash('sha256').update(workerSource).digest('hex');
const workerName = `engine-worker.${workerDigest}.js`;
const workerPath = path.join(projectRoot, 'public', workerName);
const browserPath = path.join(projectRoot, 'public/browser.html');
const browser = await readFile(browserPath, 'utf8');
const updatedBrowser = browser.replace(
  /new Worker\(new URL\('\.\/engine-worker\.[a-f0-9]+\.js'/,
  `new Worker(new URL('./${workerName}'`,
);

if (updatedBrowser === browser && !browser.includes(`./${workerName}`)) {
  throw new Error('Could not find the engine Worker asset reference in public/browser.html.');
}

await writeFile(workerPath, workerSource);
if (updatedBrowser !== browser) await writeFile(browserPath, updatedBrowser);
process.stdout.write(`Built ${adapterName} and ${workerName}\n`);
