import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SseFrameParser } from '../src/snapshot/sse-frame-parser.js';

// text/event-stream frame parser (gascity-dashboard-3rm7, Layer 2b).

describe('SseFrameParser', () => {
  test('parses a complete named event with data', () => {
    const p = new SseFrameParser();
    const events = p.push('event: pending\ndata: {"request_id":"r1"}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'pending');
    assert.equal(events[0]!.data, '{"request_id":"r1"}');
  });

  test('strips a single leading space after the field colon', () => {
    const p = new SseFrameParser();
    const [ev] = p.push('event:pending\ndata:x\n\n'); // no space
    assert.equal(ev!.event, 'pending');
    assert.equal(ev!.data, 'x');
  });

  test('joins multiple data lines with newline', () => {
    const p = new SseFrameParser();
    const [ev] = p.push('data: a\ndata: b\n\n');
    assert.equal(ev!.data, 'a\nb');
    assert.equal(ev!.event, 'message'); // default type
  });

  test('reassembles an event split across chunks (mid-line and mid-event)', () => {
    const p = new SseFrameParser();
    assert.deepEqual(p.push('event: pen'), []);
    assert.deepEqual(p.push('ding\ndata: {"request_id":'), []);
    const events = p.push('"r9"}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'pending');
    assert.equal(events[0]!.data, '{"request_id":"r9"}');
  });

  test('ignores comment/heartbeat lines', () => {
    const p = new SseFrameParser();
    assert.deepEqual(p.push(':\n'), []);
    assert.deepEqual(p.push(': keep-alive\n'), []);
    const [ev] = p.push('event: pending\ndata: x\n\n');
    assert.equal(ev!.event, 'pending');
  });

  test('carries id and persists it as last-event-id across events', () => {
    const p = new SseFrameParser();
    const [a] = p.push('id: 7\nevent: pending\ndata: x\n\n');
    assert.equal(a!.id, '7');
    const [b] = p.push('event: pending\ndata: y\n\n'); // no new id
    assert.equal(b!.id, '7'); // persists
  });

  test('handles CRLF line endings', () => {
    const p = new SseFrameParser();
    const [ev] = p.push('event: pending\r\ndata: x\r\n\r\n');
    assert.equal(ev!.event, 'pending');
    assert.equal(ev!.data, 'x');
  });

  test('a blank line with nothing buffered does not emit a phantom event', () => {
    const p = new SseFrameParser();
    assert.deepEqual(p.push('\n\n'), []);
  });

  test('emits multiple events from one chunk', () => {
    const p = new SseFrameParser();
    const events = p.push('event: pending\ndata: 1\n\nevent: pending\ndata: 2\n\n');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.data), ['1', '2']);
  });
});
