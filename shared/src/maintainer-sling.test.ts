import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMaintainerSlingRecord, prepareMaintainerSlingRequest } from './maintainer-sling.js';

const defaults = {
  slingTarget: 'mayor',
  triageTarget: 'chief-of-staff',
};

test('prepareMaintainerSlingRequest resolves triage target and composes supervisor bead text', () => {
  const prepared = prepareMaintainerSlingRequest(
    {
      kind: 'issue',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/issues/47',
      intent: 'triage',
    },
    defaults,
  );

  assert.equal(prepared.status, 'ok');
  assert.equal(prepared.request.target, 'chief-of-staff');
  assert.equal(
    prepared.request.beadText,
    'Please triage https://github.com/gastownhall/gascity/issues/47',
  );
});

test('prepareMaintainerSlingRequest keeps draft on the generic sling target', () => {
  const prepared = prepareMaintainerSlingRequest(
    {
      kind: 'issue',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/issues/47',
      intent: 'draft',
    },
    defaults,
  );

  assert.equal(prepared.status, 'ok');
  assert.equal(prepared.request.target, 'mayor');
  assert.equal(
    prepared.request.beadText,
    'Please draft a PR addressing https://github.com/gastownhall/gascity/issues/47',
  );
});

test('prepareMaintainerSlingRequest rejects kind/html_url mismatches and malformed targets', () => {
  assert.deepEqual(
    prepareMaintainerSlingRequest(
      {
        kind: 'pr',
        number: 47,
        html_url: 'https://github.com/gastownhall/gascity/issues/47',
        intent: 'review',
      },
      defaults,
    ),
    { status: 'error', message: 'kind/html_url mismatch' },
  );

  assert.deepEqual(
    prepareMaintainerSlingRequest(
      {
        kind: 'issue',
        number: 47,
        html_url: 'https://github.com/gastownhall/gascity/issues/47',
        intent: 'triage',
        target: '../bad',
      },
      defaults,
    ),
    { status: 'error', message: 'invalid target alias' },
  );
});

test('decodeMaintainerSlingRecord validates the dashboard-local record payload', () => {
  const decoded = decodeMaintainerSlingRecord({
    kind: 'issue',
    number: 47,
    intent: 'triage',
    target: 'chief-of-staff',
    bead_id: 'gc-255139',
    resolved_session_name: 'oversight-rig__chief-of-staff',
  });

  assert.equal(decoded.status, 'ok');
  assert.deepEqual(decoded.record, {
    kind: 'issue',
    number: 47,
    intent: 'triage',
    target: 'chief-of-staff',
    bead_id: 'gc-255139',
    resolved_session_name: 'oversight-rig__chief-of-staff',
  });
});
