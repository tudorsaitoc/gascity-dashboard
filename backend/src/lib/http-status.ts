export const HTTP_STATUS = {
  ok: 200,
  accepted: 202,
  badRequest: 400,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  misdirectedRequest: 421,
  unprocessableContent: 422,
  badGateway: 502,
  gatewayTimeout: 504,
  internalServerError: 500,
} as const;
