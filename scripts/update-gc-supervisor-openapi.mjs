import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SCHEMA_URL = 'http://127.0.0.1:8372/openapi.json';
const outputPath = path.resolve('backend/openapi/gc-supervisor.openapi.json');
const schemaUrl = process.env.GC_SUPERVISOR_OPENAPI_URL ?? DEFAULT_SCHEMA_URL;

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function assertOpenApiSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('gc supervisor OpenAPI response must be a JSON object');
  }
  if (typeof value.openapi !== 'string' || value.openapi.length === 0) {
    throw new Error('gc supervisor OpenAPI response is missing openapi version');
  }
  if (!value.paths || typeof value.paths !== 'object' || Array.isArray(value.paths)) {
    throw new Error('gc supervisor OpenAPI response is missing paths object');
  }
}

const response = await fetch(schemaUrl, {
  headers: { Accept: 'application/json' },
});

if (!response.ok) {
  throw new Error(`gc supervisor OpenAPI fetch returned ${response.status}`);
}

const schema = await response.json();
assertOpenApiSchema(schema);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(normalizeJson(schema), null, 2)}\n`, 'utf8');

console.log(`updated ${path.relative(process.cwd(), outputPath)} from ${schemaUrl}`);
