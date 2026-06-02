// Incremental text/event-stream frame parser (gascity-dashboard-3rm7, Layer 2b).
// The repo's sse-proxy only PIPES raw SSE bytes; consuming a stream server-side
// (to observe `pending` events) needs an actual frame parser. This one is pure
// and incremental: feed it decoded string chunks (which may split mid-line or
// mid-event across reads) and it returns the complete events parsed so far.
//
// Implements the dispatch subset of the WHATWG event-stream spec we rely on:
// `event:`, `data:` (multiple lines joined by \n), `id:` (persists as the
// last-event-id across events), blank line = dispatch, leading `:` = comment
// (heartbeat). `retry:` and unknown fields are ignored. A single optional
// leading space after the field colon is stripped.

export interface SseEvent {
  /** The event type; 'message' when no `event:` field was present. */
  readonly event: string;
  /** The concatenated `data:` payload (lines joined by \n). */
  readonly data: string;
  /** The most recent `id:` value, if any (persists across events per spec). */
  readonly id?: string;
}

export class SseFrameParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];
  private lastId: string | undefined;
  private dirty = false;

  /** Feed a decoded chunk; returns any events completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        const event = this.dispatch();
        if (event !== null) out.push(event);
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') {
        this.eventType = value;
        this.dirty = true;
      } else if (field === 'data') {
        this.dataLines.push(value);
        this.dirty = true;
      } else if (field === 'id') {
        this.lastId = value;
        this.dirty = true;
      }
      // retry / unknown fields ignored
    }
    return out;
  }

  private dispatch(): SseEvent | null {
    if (!this.dirty) return null; // blank line with nothing buffered
    const event: SseEvent = {
      event: this.eventType === '' ? 'message' : this.eventType,
      data: this.dataLines.join('\n'),
    };
    if (this.lastId !== undefined) {
      (event as { id?: string }).id = this.lastId; // lastId persists; field-set resets
    }
    this.eventType = '';
    this.dataLines = [];
    this.dirty = false;
    return event;
  }
}
