import { act, cleanup, renderHook } from "@testing-library/react";
import { GC_EVENT_PREFIX } from "gas-city-dashboard-shared";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from "vitest";
import { reportClientError } from "../lib/clientErrorReporting";
import { useGcEventRefresh } from "./useGcEvents";

const eventSources: FakeEventSource[] = [];
const mockReportClientError = reportClientError as Mock;

vi.mock("../lib/clientErrorReporting", () => ({
  reportClientError: vi.fn(() => Promise.resolve({ status: "reported" })),
}));

describe("useGcEventRefresh", () => {
  beforeEach(() => {
    eventSources.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    mockReportClientError.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fires once for a matching named gc event", () => {
    const onMatch = vi.fn();
    const { result } = renderHook(() =>
      useGcEventRefresh([GC_EVENT_PREFIX.bead], onMatch),
    );

    act(() => eventSources[0]?.open());
    expect(result.current).toBe("open");

    act(() =>
      eventSources[0]?.emitNamed(
        "event",
        JSON.stringify({ type: "bead.updated" }),
      ),
    );

    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("open");
  });

  it("lets callers ignore prefix-matching events outside their projection", () => {
    const onMatch = vi.fn();
    const { result } = renderHook(() =>
      useGcEventRefresh([GC_EVENT_PREFIX.bead], onMatch, {
        matches: (event) => event.run?.run_id === "current-run",
      }),
    );

    act(() => eventSources[0]?.open());
    expect(result.current).toBe("open");

    act(() =>
      eventSources[0]?.emitNamed(
        "event",
        JSON.stringify({
          type: "bead.updated",
          run: { run_id: "other-run" },
        }),
      ),
    );
    expect(onMatch).not.toHaveBeenCalled();

    act(() =>
      eventSources[0]?.emitNamed(
        "event",
        JSON.stringify({
          type: "bead.updated",
          run: { run_id: "current-run" },
        }),
      ),
    );
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it("surfaces malformed event payloads as degraded instead of silently swallowing them", () => {
    const onMatch = vi.fn();
    const { result } = renderHook(() =>
      useGcEventRefresh([GC_EVENT_PREFIX.bead], onMatch),
    );

    act(() => eventSources[0]?.open());
    act(() => eventSources[0]?.emitNamed("event", "not json"));

    expect(onMatch).not.toHaveBeenCalled();
    expect(result.current).toBe("degraded");
    expect(mockReportClientError).toHaveBeenCalledWith({
      component: "gc-events",
      operation: "parse event",
      message: "Malformed gc event payload: invalid JSON.",
    });
  });

  it("reports closed when EventSource is unavailable", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("EventSource", undefined);

    const { result } = renderHook(() =>
      useGcEventRefresh([GC_EVENT_PREFIX.bead], vi.fn()),
    );

    expect(result.current).toBe("closed");
  });

  it("does not open a city event stream when no prefixes are requested", () => {
    const { result } = renderHook(() => useGcEventRefresh([], vi.fn()));

    expect(result.current).toBe("closed");
    expect(eventSources).toHaveLength(0);
  });
});

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string | URL) {
    eventSources.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitNamed(type: string, data: string): void {
    const event = new MessageEvent<string>(type, { data });
    this.listeners.get(type)?.forEach((listener) => listener(event));
    if (type === "message") this.onmessage?.(event);
  }
}
