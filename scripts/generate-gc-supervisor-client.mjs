import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const checkOnly = process.argv.includes('--check');
const heyApiConfigPath = path.resolve('backend/openapi-ts.config.ts');
const heyApiCliPath = path.resolve('node_modules/@hey-api/openapi-ts/bin/run.js');
const supervisorClientOutputs = [
  {
    label: 'backend',
    path: path.resolve('backend/src/generated/gc-supervisor-client'),
  },
  {
    label: 'frontend',
    path: path.resolve('frontend/src/generated/gc-supervisor-client'),
  },
];

async function generateHeyApiClient(toPath) {
  await rm(toPath, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [heyApiCliPath, '--file', heyApiConfigPath, '--no-log-file'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        GC_SUPERVISOR_HEY_API_OUTPUT: toPath,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`@hey-api/openapi-ts failed with exit code ${result.status ?? 'unknown'}`);
  }
  await allowRfc3339OffsetDateTimes(toPath);
  await allowVersionlessFormulaResponses(toPath);
}

async function allowRfc3339OffsetDateTimes(toPath) {
  const zodPath = path.join(toPath, 'zod.gen.ts');
  const content = await readFile(zodPath, 'utf8');
  const patched = content.replaceAll('z.iso.datetime()', 'z.iso.datetime({ offset: true })');
  if (patched === content) {
    throw new Error(
      `${path.relative(process.cwd(), zodPath)} did not contain generated date-time validators`,
    );
  }
  await writeFile(zodPath, patched);
}

// The supervisor omits `version` from formula responses whose definition is
// inferred from a bead title rather than a versioned recipe (e.g.
// mol-focus-review). The OpenAPI snapshot still marks FormulaDetailResponse and
// FormulaSummaryResponse `version` as required, so the generated zod validator
// rejected those valid 200 payloads as `invalid_payload`, degrading the
// run-detail Formula Detail panel (gascity-dashboard-3eo8). Relax `version` to
// optional on the two formula response schemas only — every other schema keeps
// its required `version`. The durable fix is upstream marking these optional in
// the supervisor OpenAPI; remove this patch once the regenerated snapshot does.
const FORMULA_VERSION_SCHEMAS = ['zFormulaDetailResponse', 'zFormulaSummaryResponse'];

async function allowVersionlessFormulaResponses(toPath) {
  const zodPath = path.join(toPath, 'zod.gen.ts');
  const content = await readFile(zodPath, 'utf8');
  let patched = content;
  for (const schemaName of FORMULA_VERSION_SCHEMAS) {
    const requiredVersion = new RegExp(
      `(export const ${schemaName} = z\\.object\\(\\{[\\s\\S]*?\\bversion: z\\.string\\(\\))(?!\\.optional\\(\\))`,
    );
    const next = patched.replace(requiredVersion, '$1.optional()');
    if (next === patched) {
      throw new Error(
        `${path.relative(process.cwd(), zodPath)} did not contain a required ${schemaName} version validator`,
      );
    }
    patched = next;
  }
  await writeFile(zodPath, patched);
}

if (checkOnly) {
  for (const output of supervisorClientOutputs) {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), `gc-supervisor-openapi-${output.label}-`));
    const tmpHeyApiPath = path.join(tmpDir, 'gc-supervisor-client');
    try {
      await generateHeyApiClient(tmpHeyApiPath);
      await assertDirectoryMatches(tmpHeyApiPath, output.path);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  console.log('generated gc supervisor clients are up to date');
} else {
  for (const output of supervisorClientOutputs) {
    await generateHeyApiClient(output.path);
    console.log(`generated ${path.relative(process.cwd(), output.path)}`);
  }
}

async function assertDirectoryMatches(expectedPath, actualPath) {
  const [expected, actual] = await Promise.all([
    readDirectoryFiles(expectedPath),
    readDirectoryFiles(actualPath),
  ]);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error(
      `${path.relative(process.cwd(), actualPath)} is out of date. Run npm run openapi:gc-supervisor:generate.`,
    );
  }
  for (const key of expectedKeys) {
    if (expected[key] !== actual[key]) {
      throw new Error(
        `${path.relative(process.cwd(), path.join(actualPath, key))} is out of date. Run npm run openapi:gc-supervisor:generate.`,
      );
    }
  }
}

async function readDirectoryFiles(rootPath, relative = '') {
  const currentPath = path.join(rootPath, relative);
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readDirectoryFiles(rootPath, entryRelative));
      continue;
    }
    files[entryRelative] = await readFile(path.join(rootPath, entryRelative), 'utf8');
  }
  return files;
}
