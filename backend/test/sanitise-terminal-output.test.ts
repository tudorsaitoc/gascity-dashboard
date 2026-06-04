import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitiseTerminalOutput } from '../src/exec.js';

// gascity-dashboard-3sxy / gascity-dashboard-cnu: sanitiseTerminalOutput
// is the server-side strip applied to peek-style supervisor output before
// it reaches the browser (and before ansi_up renders any surviving SGR).
//
// Until 3sxy/cnu it covered ANSI CSI (non-SGR) + OSC + the C0 control
// range (\x00-\x08, \x0b-\x1f, \x7f). The two follow-ups extend it to:
//
//   - C1 controls (\x80-\x9f). Legacy 8-bit control codes; some terminals
//     still interpret them as alternative escape introducers, so they are
//     the same threat class as C0 + ANSI escapes.
//   - Unicode Bidi / RTL overrides (U+202A-202E, U+2066-2069). These
//     reorder the visual rendering of text without changing its bytes —
//     the canonical "trojan source" vector. They must never survive into
//     a UI string sourced from a supervisor or third-party transcript.
//
// \t and \n stay legal; they are the documented exceptions that
// sanitiseTerminalOutput preserves for multi-line peek output.

describe('sanitiseTerminalOutput', () => {
  test('preserves plain visible text and the \\t / \\n exceptions', () => {
    const input = 'hello\tworld\nline two';
    assert.equal(sanitiseTerminalOutput(input), 'hello\tworld\nline two');
  });

  test('strips ANSI escape sequences (CSI + OSC) and the lone ESC byte', () => {
    // The pipeline is OSC strip → non-SGR CSI strip → CTRL_RE. CTRL_RE
    // covers \x1b, so any ESC bytes still attached to an SGR sequence
    // are removed too — the visible "[31m" bracket-payload survives as
    // plain text but no ANSI-renderable sequence remains.
    const input = 'red \x1b[31mblock\x1b[0m end \x1b]0;title\x07 cleared\x1b[2J';
    const cleaned = sanitiseTerminalOutput(input);
    // Every ESC byte is gone — no live escape sequences reach the client.
    assert.doesNotMatch(cleaned, /\x1b/);
    // OSC payload is stripped wholesale (it's gone with its bracket
    // contents), but the visible non-escape text survives.
    assert.match(cleaned, /red/);
    assert.match(cleaned, /block/);
    assert.match(cleaned, /end/);
    assert.match(cleaned, /cleared/);
    assert.doesNotMatch(cleaned, /title/);
  });

  test('strips C0 control characters except \\t / \\n', () => {
    const input = 'foo\x00\x01\x07\x08\x0c\x1fbar\x7fbaz';
    const cleaned = sanitiseTerminalOutput(input);
    assert.doesNotMatch(cleaned, /[\x00-\x08\x0b-\x1f\x7f]/);
    assert.equal(cleaned, 'foobarbaz');
  });

  test('strips OSC sequences terminated by ST (ESC \\) — gascity-dashboard-3sxy.1', () => {
    // Modern terminals (iTerm2, foot, wezterm) emit OSC sequences
    // terminated by the two-byte String Terminator ESC + '\' rather than
    // BEL. Prior to 3sxy.1 the OSC_RE only matched BEL-terminated OSC,
    // so the ST-terminated payload survived: CTRL_RE stripped the
    // leading ESC and the trailing ESC of ST, leaving "]0;title\"
    // as visible plain text in the rendered transcript.
    const input = 'before \x1b]0;title\x1b\\ after';
    const cleaned = sanitiseTerminalOutput(input);
    assert.doesNotMatch(cleaned, /\x1b/);
    // Neither the OSC payload nor the ST backslash leak through.
    assert.doesNotMatch(cleaned, /title/);
    assert.doesNotMatch(cleaned, /0;/);
    assert.doesNotMatch(cleaned, /\\/);
    assert.match(cleaned, /before/);
    assert.match(cleaned, /after/);
  });

  test('strips both BEL- and ST-terminated OSC in the same payload', () => {
    // Realistic case: one terminal emitter uses BEL, another uses ST;
    // a transcript pulled from multiple sources mixes both.
    const input = 'A\x1b]0;bel-title\x07B\x1b]0;st-title\x1b\\C';
    const cleaned = sanitiseTerminalOutput(input);
    assert.equal(cleaned, 'ABC');
  });

  test('OSC regex is non-greedy across adjacent OSCs', () => {
    // Two ST-terminated OSCs back to back. A greedy or mis-bounded regex
    // would consume the inter-OSC text along with both payloads.
    const input = '\x1b]0;one\x1b\\MID\x1b]2;two\x1b\\';
    const cleaned = sanitiseTerminalOutput(input);
    assert.equal(cleaned, 'MID');
  });

  test('unterminated OSC does not swallow trailing escape sequences', () => {
    // The char-class exclusion of \x1b inside OSC_RE means the regex
    // cannot run past an unterminated OSC into a following CSI; the
    // unterminated payload falls through to CSI/CTRL strips instead,
    // which still removes every escape byte. The point is: no live
    // \x1b reaches the client even on malformed input.
    const input = 'pre \x1b]0;never-closed then \x1b[31mred\x1b[0m post';
    const cleaned = sanitiseTerminalOutput(input);
    assert.doesNotMatch(cleaned, /\x1b/);
    assert.match(cleaned, /pre/);
    assert.match(cleaned, /post/);
  });

  test('strips C1 control characters (\\x80-\\x9f)', () => {
    // C1 controls — the 0x80..0x9F range. Building the fixture
    // programmatically keeps the source file plain-ASCII while still
    // exercising every byte in the range.
    let c1 = '';
    for (let code = 0x80; code <= 0x9f; code += 1) {
      c1 += String.fromCharCode(code);
    }
    const input = `start${c1}end`;
    const cleaned = sanitiseTerminalOutput(input);
    assert.equal(cleaned, 'startend');
    for (let code = 0x80; code <= 0x9f; code += 1) {
      assert.ok(
        !cleaned.includes(String.fromCharCode(code)),
        `C1 byte 0x${code.toString(16)} survived`,
      );
    }
  });

  test('strips Bidi / RTL override characters (all 12 from CVE-2021-42574)', () => {
    // Phase-4 M1: cover the FULL trojan-source set, not just the 9
    // embedding/override codepoints. The 3 directional marks (ALM/LRM/
    // RLM) are zero-width but live in the same Unicode bidi-control
    // category — the original CVE-2021-42574 paper enumerates all 12.
    const bidi = [
      '؜', // ALM (Arabic Letter Mark) — Phase-4 M1
      '‎', // LRM (Left-to-Right Mark) — Phase-4 M1
      '‏', // RLM (Right-to-Left Mark) — Phase-4 M1
      '‪', // LRE
      '‫', // RLE
      '‬', // PDF
      '‭', // LRO
      '‮', // RLO
      '⁦', // LRI
      '⁧', // RLI
      '⁨', // FSI
      '⁩', // PDI
    ].join('');
    const input = `admin${bidi}fake`;
    const cleaned = sanitiseTerminalOutput(input);
    assert.equal(cleaned, 'adminfake');
  });

  test('strips C1 + Bidi + ANSI from a combined payload', () => {
    // The realistic worst case: ANSI escape + C1 NEL + Bidi RLO +
    // cursor-move CSI in one line. Every control class is gone; the
    // visible (printable) text survives.
    const input = 'storage \x1b[31mblocked\x1b[0m\x85‮[admin]\x1b[2J end';
    const cleaned = sanitiseTerminalOutput(input);
    assert.doesNotMatch(cleaned, /\x1b/);
    assert.doesNotMatch(cleaned, /[\x80-\x9f]/);
    assert.doesNotMatch(cleaned, /[‪-‮⁦-⁩]/);
    assert.match(cleaned, /storage/);
    assert.match(cleaned, /blocked/);
    assert.match(cleaned, /\[admin\]/);
    assert.match(cleaned, /end/);
  });
});
