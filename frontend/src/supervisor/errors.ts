export type SupervisorResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

const SUPERVISOR_SCHEMA_VALIDATION_MESSAGE = 'gc supervisor response failed validation';

export class SupervisorApiError extends Error {
  override readonly name = 'SupervisorApiError';

  constructor(
    public readonly status: number | undefined,
    message: string,
    public readonly requestId: string | undefined,
  ) {
    super(message);
  }
}

export async function unwrapSupervisorResult<T>(
  promise: Promise<SupervisorResult<T>>,
  emptyMessage: string,
): Promise<T> {
  let result: SupervisorResult<T>;
  try {
    result = await promise;
  } catch (err) {
    throw normalizeThrownSupervisorError(err);
  }

  const { response } = result;
  if (response === undefined) {
    throw new SupervisorApiError(undefined, messageFromUnknown(result.error), undefined);
  }
  if (!response.ok || result.error !== undefined) {
    throw new SupervisorApiError(
      response.status,
      messageFromUnknown(result.error, response.statusText),
      response.headers.get('x-gc-request-id') ?? undefined,
    );
  }
  const data = result.data;
  if (data === undefined) {
    throw new SupervisorApiError(
      response.status,
      emptyMessage,
      response.headers.get('x-gc-request-id') ?? undefined,
    );
  }
  return data;
}

function normalizeThrownSupervisorError(err: unknown): SupervisorApiError {
  if (err instanceof SupervisorApiError) return err;
  return new SupervisorApiError(undefined, messageFromUnknown(err), undefined);
}

function messageFromUnknown(
  value: unknown,
  defaultMessage = 'gc supervisor request failed',
): string {
  if (isGeneratedSchemaValidationError(value)) return SUPERVISOR_SCHEMA_VALIDATION_MESSAGE;
  if (typeof value === 'string' && value.trim().length > 0) {
    return sanitizeSupervisorMessage(value);
  }
  if (value instanceof Error && value.message.trim().length > 0) {
    return sanitizeSupervisorMessage(value.message);
  }
  if (isRecord(value)) {
    for (const key of ['error', 'message', 'detail']) {
      const field = value[key];
      if (typeof field === 'string' && field.trim().length > 0) {
        return sanitizeSupervisorMessage(field);
      }
    }
  }
  return defaultMessage;
}

function sanitizeSupervisorMessage(message: string): string {
  const trimmed = message.trim();
  return isGeneratedSchemaValidationMessage(trimmed)
    ? SUPERVISOR_SCHEMA_VALIDATION_MESSAGE
    : trimmed;
}

function isGeneratedSchemaValidationError(value: unknown): boolean {
  if (value instanceof Error) {
    return value.name === 'ZodError' || isGeneratedSchemaValidationMessage(value.message);
  }
  return isZodIssueList(value);
}

function isGeneratedSchemaValidationMessage(message: string): boolean {
  if (!message.startsWith('[') && !message.startsWith('{')) return false;
  try {
    return isZodIssueList(JSON.parse(message));
  } catch {
    return false;
  }
}

function isZodIssueList(value: unknown): boolean {
  const issues = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.issues)
      ? value.issues
      : null;
  return (
    issues !== null &&
    issues.length > 0 &&
    issues.every(
      (issue) => isRecord(issue) && typeof issue.code === 'string' && Array.isArray(issue.path),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
