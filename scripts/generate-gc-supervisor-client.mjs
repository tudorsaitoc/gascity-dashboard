import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const checkOnly = process.argv.includes('--check');
const schemaPath = path.resolve('backend/openapi/gc-supervisor.openapi.json');
const outputPath = path.resolve('backend/src/generated/gc-supervisor.ts');
const schemaOutputPath = path.resolve('backend/src/generated/gc-supervisor-schemas.ts');
const cliPath = path.resolve('node_modules/openapi-typescript/bin/cli.js');
const header = [
  '/* eslint-disable */',
  '// Generated from backend/openapi/gc-supervisor.openapi.json. Do not edit.',
  '',
].join('\n');

async function generateTypes(toPath) {
  const result = spawnSync(
    process.execPath,
    [cliPath, schemaPath, '--output', toPath, '--export-type'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`openapi-typescript failed with exit code ${result.status ?? 'unknown'}`);
  }
  const generated = await readFile(toPath, 'utf8');
  await writeFile(
    toPath,
    generated.startsWith(header) ? generated : `${header}${generated}`,
    'utf8',
  );
}

async function generateRuntimeSchemas(toPath) {
  const openapi = JSON.parse(await readFile(schemaPath, 'utf8'));
  const allSchemas = openapi?.components?.schemas;
  if (!isRecord(allSchemas)) {
    throw new Error('OpenAPI schema is missing components.schemas');
  }
  applyRuntimeSchemaOverlays(allSchemas);
  const selected = Object.fromEntries(
    Object.keys(allSchemas)
      .sort()
      .map((name) => [name, normalizeJson(allSchemas[name])]),
  );
  const source = [
    header,
    'export const gcSupervisorComponentSchemas: Record<string, unknown> = ',
    JSON.stringify(selected, null, 2),
    ';\n',
  ].join('');
  await writeFile(toPath, source, 'utf8');
}

if (checkOnly) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-supervisor-openapi-'));
  const tmpTypesPath = path.join(tmpDir, 'gc-supervisor.ts');
  const tmpSchemasPath = path.join(tmpDir, 'gc-supervisor-schemas.ts');
  try {
    await Promise.all([
      generateTypes(tmpTypesPath),
      generateRuntimeSchemas(tmpSchemasPath),
    ]);
    const [
      expectedTypes,
      actualTypes,
      expectedSchemas,
      actualSchemas,
    ] = await Promise.all([
      readFile(tmpTypesPath, 'utf8'),
      readFile(outputPath, 'utf8'),
      readFile(tmpSchemasPath, 'utf8'),
      readFile(schemaOutputPath, 'utf8'),
    ]);
    if (expectedTypes !== actualTypes) {
      throw new Error(
        'backend/src/generated/gc-supervisor.ts is out of date. Run npm run openapi:gc-supervisor:generate.',
      );
    }
    if (expectedSchemas !== actualSchemas) {
      throw new Error(
        'backend/src/generated/gc-supervisor-schemas.ts is out of date. Run npm run openapi:gc-supervisor:generate.',
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  console.log('generated gc supervisor client is up to date');
} else {
  await Promise.all([
    generateTypes(outputPath),
    generateRuntimeSchemas(schemaOutputPath),
  ]);
  console.log(`generated ${path.relative(process.cwd(), outputPath)}`);
  console.log(`generated ${path.relative(process.cwd(), schemaOutputPath)}`);
}

function applyRuntimeSchemaOverlays(allSchemas) {
  // Observed supervisor wire drift: non-engineering beads can carry
  // priority:null while the current OpenAPI component says integer-only.
  // Keep the generated validator strict everywhere else, and remove this
  // overlay once the upstream schema marks priority nullable.
  const bead = allSchemas.Bead;
  if (!isRecord(bead)) return;
  const properties = bead.properties;
  if (!isRecord(properties)) return;
  const priority = properties.priority;
  if (!isRecord(priority)) return;
  priority.type = ['integer', 'null'];
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
