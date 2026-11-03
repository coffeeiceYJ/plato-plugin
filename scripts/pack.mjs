import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, sep } from 'node:path';
const project = fileURLToPath(new URL('../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(dist, { recursive: true });
if (!process.env.npm_execpath) throw new Error('Run with npm run pack:plugin');
const stage = await mkdtemp(join(dist, '.pack-'));
try {
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest.types;
  manifest.exports['.'] = { default: './lib/index.js' };
  const sdkSource = join(project, 'node_modules/@software-factory/runtime-sdk');
  const sdkManifest = JSON.parse(await readFile(join(sdkSource, 'package.json'), 'utf8'));
  manifest.dependencies['@software-factory/runtime-sdk'] = sdkManifest.version;
  manifest.files = manifest.files.filter(path => path !== 'vendor/');
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const path of manifest.files) {
    await cp(join(project, path), join(stage, path), {
      recursive: true,
      filter: source => !source.endsWith('.d.ts') && !source.endsWith('.pyc')
        && !source.includes('__pycache__') && basename(source) !== 'source-manifest.json',
    });
  }
  const sdkTarget = join(stage, 'node_modules/@software-factory/runtime-sdk');
  await mkdir(join(sdkTarget, 'lib'), { recursive: true });
  // Keep the original executable byte-for-byte, with only runtime package metadata.
  await cp(join(sdkSource, 'lib/index.js'), join(sdkTarget, 'lib/index.js'));
  await writeFile(join(sdkTarget, 'package.json'), JSON.stringify({
    name: sdkManifest.name, version: sdkManifest.version, type: sdkManifest.type,
    main: sdkManifest.main, exports: { '.': { default: './lib/index.js' }, './package.json': './package.json' },
    peerDependencies: sdkManifest.peerDependencies, engines: sdkManifest.engines,
  }, null, 2));
  const result = spawnSync(process.execPath,
    [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', dist],
    { cwd: stage, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const report = JSON.parse(result.stdout)[0];
  const forbidden = report.files.filter(f => /(?:^|\/)(?:\.env|config\.yaml|\.venv|__pycache__|test-results|\.credentials|vendor|skills|examples|docs)(?:\/|$)/.test(f.path)
    || f.path.endsWith('.d.ts') || f.path.endsWith('source-manifest.json'));
  if (forbidden.length) throw new Error('Release contains development files: ' + forbidden.map(f => f.path).join(', '));
  if (!report.bundled.includes('@software-factory/runtime-sdk')) throw new Error('Runtime SDK must remain bundled');
  await writeFile(join(dist, 'package-check.json'), JSON.stringify({
    name: report.name, version: report.version, filename: report.filename,
    size: report.size, integrity: report.integrity, bundled: report.bundled,
    files: report.files.map(file => file.path),
  }, null, 2));
  console.log(JSON.stringify({ filename: report.filename, size: report.size, files: report.files.length, bundled: report.bundled }, null, 2));
} finally {
  const resolvedDist = await realpath(dist), resolvedStage = await realpath(stage);
  const child = relative(resolvedDist, resolvedStage);
  if (!child.startsWith('.pack-') || child.includes(sep) || child.includes('..')) throw new Error('Unexpected staging cleanup path');
  await rm(resolvedStage, { recursive: true, force: true });
}
