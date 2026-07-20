import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslintBin = resolve(
  projectRoot,
  `node_modules/.bin/eslint${process.platform === 'win32' ? '.cmd' : ''}`,
);
const targets = ['.', '../app'];
const args = [
  '--quiet',
  '--config',
  '.eslintrc.js',
  '--no-eslintrc',
  '--ext',
  '.js,.jsx,.ts,.tsx',
  ...targets,
];

console.log(`eslint: bounded mobile shell source (${targets.join(', ')})`);

const result = spawnSync(eslintBin, args, {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status || 0);
