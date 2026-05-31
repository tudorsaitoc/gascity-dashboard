// Backend re-export of the shared city-name grammar (gascity-dashboard-ucc).
//
// The grammar is the SSOT in `gas-city-dashboard-shared` (shared/src/city.ts)
// so the backend's two validation sites — config.ts (GC_CITY_NAME at boot)
// and the `/api/city/:cityName` dispatch middleware — and the frontend's
// `/city/:cityName` route guard are provably the same regex. A city name
// lands as a path segment under ~/.gascity-dashboard/cities/<cityName>/ and
// as the request-plane dispatch key, so the no-separator grammar is what
// keeps a crafted segment from escaping via path.join or hitting the wrong
// runtime.
export { CITY_NAME_RE, isValidCityName } from 'gas-city-dashboard-shared';
