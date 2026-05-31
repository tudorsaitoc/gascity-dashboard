import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { gcSupervisorComponentSchemas } from './generated/gc-supervisor-schemas.js';

type PathSegment = string | number;

export interface OpenApiValidationIssue {
  readonly path: readonly PathSegment[];
  readonly expected: string;
}

const COMPONENT_REF_PREFIX = '#/components/schemas/';

const ajv = new Ajv({
  allErrors: false,
  jsonPointers: true,
});
ajv.addFormat('int64', {
  type: 'number',
  validate: (value: number) => Number.isSafeInteger(value),
});
ajv.addFormat('double', {
  type: 'number',
  validate: (value: number) => Number.isFinite(value),
});

const validators = new Map<string, ValidateFunction>();

for (const [name, schema] of Object.entries(gcSupervisorComponentSchemas)) {
  ajv.addSchema(schema as object, componentRef(name));
}

export function validateGcSupervisorComponent(
  componentName: string,
  value: unknown,
): OpenApiValidationIssue | undefined {
  const validate = componentValidator(componentName);
  return validate(value) ? undefined : issueFromAjvError(validate.errors?.[0]);
}

export function openApiIssuePath(path: readonly PathSegment[]): string {
  if (path.length === 0) return 'payload';
  return `payload${path.map((part) => {
    if (typeof part === 'number') return `[${part}]`;
    return `.${part}`;
  }).join('')}`;
}

function componentValidator(componentName: string): ValidateFunction {
  const cached = validators.get(componentName);
  if (cached !== undefined) return cached;
  const validate = ajv.getSchema(componentRef(componentName));
  if (validate === undefined) {
    throw new Error(`gc supervisor OpenAPI schema ${componentName} is not generated`);
  }
  validators.set(componentName, validate);
  return validate;
}

function componentRef(componentName: string): string {
  return `${COMPONENT_REF_PREFIX}${componentName}`;
}

function issueFromAjvError(error: ErrorObject | undefined): OpenApiValidationIssue {
  if (error === undefined) return { path: [], expected: 'valid' };
  if (error.keyword === 'required') {
    return {
      path: [...pathFromDataPath(error.dataPath), stringParam(error, 'missingProperty')],
      expected: 'present',
    };
  }
  if (error.keyword === 'additionalProperties') {
    return {
      path: [...pathFromDataPath(error.dataPath), stringParam(error, 'additionalProperty')],
      expected: 'absent',
    };
  }
  return {
    path: pathFromDataPath(error.dataPath),
    expected: expectedFromAjvError(error),
  };
}

function expectedFromAjvError(error: ErrorObject): string {
  switch (error.keyword) {
    case 'format':
      return stringParam(error, 'format');
    case 'type':
      return stringParam(error, 'type');
    case 'enum':
      return 'one of the allowed values';
    case 'const':
      return JSON.stringify(param(error, 'allowedValue'));
    case 'oneOf':
      return 'exactly one matching schema';
    case 'anyOf':
      return 'one matching schema';
    default:
      return error.message ?? 'valid';
  }
}

function stringParam(error: ErrorObject, key: string): string {
  const value = param(error, key);
  return typeof value === 'string' ? value : String(value);
}

function param(error: ErrorObject, key: string): unknown {
  return (error.params as Record<string, unknown>)[key];
}

function pathFromDataPath(dataPath: string): PathSegment[] {
  if (dataPath === '') return [];
  return dataPath
    .split('/')
    .slice(1)
    .map((part) => {
      const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
      return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
    });
}
