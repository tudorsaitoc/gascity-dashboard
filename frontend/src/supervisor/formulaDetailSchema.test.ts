import { describe, expect, it } from 'vitest';
import {
  zGetV0CityByCityNameFormulasByNameResponse,
  zGetV0CityByCityNameFormulaByNameResponse,
  zPostV0CityByCityNameFormulasByNamePreviewResponse,
} from '../generated/gc-supervisor-client/zod.gen';

// gascity-dashboard-3eo8: the supervisor omits `version` from formula
// responses whose definition is inferred from a bead title (e.g.
// mol-focus-review). The generated zod validator the SDK runs on the formula
// detail response previously required `version`, so it rejected those valid 200
// payloads as `invalid_payload` and degraded the run-detail Formula Detail
// panel. The generated client is post-processed to make `version` optional on
// the formula response schemas; this guards that relaxation.
const versionlessFormulaDetail = {
  name: 'mol-focus-review',
  description: 'inferred from bead title',
  var_defs: null,
  steps: null,
  deps: null,
  preview: { nodes: null, edges: null },
};

describe('generated formula detail response schema', () => {
  it('accepts a version-less formula payload', () => {
    for (const schema of [
      zGetV0CityByCityNameFormulasByNameResponse,
      zGetV0CityByCityNameFormulaByNameResponse,
      zPostV0CityByCityNameFormulasByNamePreviewResponse,
    ]) {
      const parsed = schema.safeParse(versionlessFormulaDetail);
      expect(parsed.success).toBe(true);
    }
  });

  it('still accepts a versioned formula payload', () => {
    const parsed = zGetV0CityByCityNameFormulasByNameResponse.safeParse({
      ...versionlessFormulaDetail,
      version: '1',
    });
    expect(parsed.success).toBe(true);
  });

  it('still rejects a payload missing a genuinely required field', () => {
    const { name: _name, ...withoutName } = versionlessFormulaDetail;
    const parsed = zGetV0CityByCityNameFormulasByNameResponse.safeParse(withoutName);
    expect(parsed.success).toBe(false);
  });
});
