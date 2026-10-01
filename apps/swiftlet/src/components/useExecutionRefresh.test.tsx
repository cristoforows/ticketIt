import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Ticket } from "../api/tickets";
import { awaitsExecution, EXECUTION_REFRESH_MS, sameData, useExecutionRefresh } from "./useExecutionRefresh";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("useExecutionRefresh", () => {
  it("refreshes every 3 seconds while active, and not before", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useExecutionRefresh(true, refresh));
    expect(EXECUTION_REFRESH_MS).toBe(3000);
    await advance(2999);
    expect(refresh).not.toHaveBeenCalled();
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(6000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("sets no timer at all while inactive", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useExecutionRefresh(false, refresh));
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never overlaps: a tick is skipped while the previous refresh is pending", async () => {
    let finish: () => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderHook(() => useExecutionRefresh(true, refresh));
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(9000);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await advance(0);
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps ticking after a refresh that rejects", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    renderHook(() => useExecutionRefresh(true, refresh));
    await advance(3000);
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops when it becomes inactive and starts again when it becomes active", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ active }) => useExecutionRefresh(active, refresh), { initialProps: { active: true } });
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ active: true });
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops on unmount", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useExecutionRefresh(true, refresh));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("calls the latest refresh function without restarting the timer", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ refresh }) => useExecutionRefresh(true, refresh), { initialProps: { refresh: first } });
    await advance(2000);
    rerender({ refresh: second });
    await advance(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("sameData", () => {
  it("compares parsed Galley data by content", () => {
    expect(sameData({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true);
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameData([1], [1, 2])).toBe(false);
  });
});

describe("awaitsExecution", () => {
  const ticket = (fields: Partial<Ticket>) => ({ openRound: null, requestingAgentWork: false, ...fields }) as Ticket;
  const openRound = { id: "r1" } as Ticket["openRound"];

  it("is true for a Ticket with an open Round or one requesting Agent work", () => {
    expect(awaitsExecution(ticket({ openRound }))).toBe(true);
    expect(awaitsExecution(ticket({ requestingAgentWork: true }))).toBe(true);
    expect(awaitsExecution(ticket({ openRound, requestingAgentWork: true }))).toBe(true);
  });

  it("is false for a Ticket that is neither", () => {
    expect(awaitsExecution(ticket({}))).toBe(false);
  });
});
