import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';

// Regression guard for zero-hardcoded-roles (gascity-dashboard-bhvn).
//
// The dashboard is a SHARED tool used by others, so it must NOT bake OUR
// operator / city / decision-label identity into source. Those values flow from
// the backend's env-driven config onto the wire (DashboardRuntimeConfig) and are
// read by the frontend via OperatorConfigContext — never imported as a literal.
//
// This test fails if a forbidden identity literal reappears in source. It scans
// the three workspaces' `src/` trees. The ONLY sanctioned homes for an identity
// literal are the config EDGES (the backend boot edge + the frontend config-edge
// context) plus test/fixture data — those are allow-listed below.

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');

const SCAN_ROOTS = ['backend/src', 'frontend/src', 'shared/src'];
const SCAN_EXTENSIONS = ['.ts', '.tsx'];

// Path fragments that exempt a file: tests and fixture/seed data legitimately
// carry concrete identities to simulate a real city.
const ALLOWED_PATH_FRAGMENTS = ['.test.', '/__tests__/', '/fixtures/'];

// The two config edges where a neutral fallback literal is sanctioned to live,
// plus one file where `'human'` is a run-phase classification keyword (e.g.
// `human-approval`), NOT the operator wire alias — a different meaning the regex
// cannot tell apart, so it is exempted explicitly rather than weakening the rule.
const ALLOWED_FILES = [
  'backend/src/config.ts',
  'frontend/src/contexts/OperatorConfigContext.tsx',
  'shared/src/runs/phaseMapping.ts',
];

// Each forbidden pattern, with the runtime-config field that replaces it.
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; useInstead: string }> = [
  {
    name: "operator display alias 'stephanie'",
    re: /stephanie/i,
    useInstead: 'operatorAlias from runtime config (OperatorConfigContext / AdminConfig)',
  },
  {
    name: "decision label 'needs/stephanie'",
    re: /needs\/stephanie/i,
    useInstead: 'decisionLabel from runtime config',
  },
  {
    name: "city 'ds-research'",
    re: /ds-research/i,
    useInstead: 'cityName from runtime config (or a generic placeholder in docs)',
  },
  {
    name: "operator wire alias 'human' (quoted literal)",
    re: /['"]human['"]/,
    useInstead: 'operatorWireAlias from runtime config',
  },
];

function isAllowed(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  if (normalized === path.relative(REPO_ROOT, THIS_FILE).split(path.sep).join('/')) return true;
  if (ALLOWED_FILES.includes(normalized)) return true;
  return ALLOWED_PATH_FRAGMENTS.some((frag) => normalized.includes(frag));
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SCAN_EXTENSIONS.includes(path.extname(full))) {
      out.push(full);
    }
  }
  return out;
}

describe('no hardcoded operator/city/decision-label literals (gascity-dashboard-bhvn)', () => {
  it('scans at least one file in every workspace (guard is wired correctly)', () => {
    for (const root of SCAN_ROOTS) {
      const files = listSourceFiles(path.join(REPO_ROOT, root));
      assert.ok(files.length > 0, `expected source files under ${root}`);
    }
  });

  it('contains no forbidden identity literals outside the config edges', () => {
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(path.join(REPO_ROOT, root))) {
        const relPath = path.relative(REPO_ROOT, file);
        if (isAllowed(relPath)) continue;
        const lines = readFileSync(file, 'utf-8').split('\n');
        lines.forEach((line, idx) => {
          for (const { name, re, useInstead } of FORBIDDEN_PATTERNS) {
            if (re.test(line)) {
              const rel = relPath.split(path.sep).join('/');
              violations.push(
                `${rel}:${idx + 1} — hardcoded ${name}; use ${useInstead}\n    ${line.trim()}`,
              );
            }
          }
        });
      }
    }
    assert.equal(
      violations.length,
      0,
      `Found hardcoded identity literals (zero-hardcoded-roles). Derive these from runtime ` +
        `config instead:\n${violations.join('\n')}`,
    );
  });
});
