import { copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const outputDirectory = resolve(projectRoot, 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const files = [
  ['index.html', 'index.html'],
  ['styles.css', 'styles.css'],
  ['app.js', 'app.js'],
  ['audio.js', 'audio.js']
];

for (const [source, destination] of files) {
  await copyFile(resolve(projectRoot, source), resolve(outputDirectory, destination));
}

console.log(`Built ${files.length} static files in ${outputDirectory}`);
