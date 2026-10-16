// @vitest-environment node
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionCapability } from "./session-capability.ts";

const makeRow = (id: string, label: string) => ({
  key: `agent:main:${id}`,
  sessionId: id,
  kind: "direct" as const,
  label,
  updatedAt: 1,
});
function makeHarness(result: (params?: unknown) => SessionsListResult) {
  const request = createGatewayRequestMock(async (method, params) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return result(params);
  });
  const client = createTestGatewayClient(request);
  return { ...createSessionCapabilityHarness(client.request.bind(client)), request };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("event-driven session list refresh", () => {
  it("bounds held-roster enumeration while reconciling overlapping session views", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      makeRow(`shared-${index}`, `Shared ${index}`),
    );
    const { sessions, emitEvent, request } = makeHarness(() =>
      sessionsResult(
        rows.map((row) => ({ ...row })),
        1,
      ),
    );
    const queries = Array.from({ length: 8 }, (_, index) => ({
      agentId: "main",
      search: "Shared",
      limit: 10 + index,
    }));
    const unsubscribers = queries.map((query) => sessions.subscribeList(query, () => undefined));
    const target = rows[0]!;
    const observed = vi.fn();
    let descriptor: ReturnType<SessionCapability["observeRow"]> | undefined;
    const heldResults = () => [
      sessions.state.result,
      ...queries.map((query) => sessions.listSnapshot(query).result),
    ];
    const findTarget = (result: SessionsListResult | null | undefined) =>
      result?.sessions.find((row) => row.key === target.key);
    const eventDelivered = vi.fn(() => ({
      descriptor: descriptor?.row,
      rows: heldResults().map(findTarget),
    }));
    let visitedRows = 0;
    const tracked = new WeakSet<SessionsListResult["sessions"]>();
    const trackHeldRows = () => {
      const held = heldResults();
      for (const result of held) {
        if (!result || tracked.has(result.sessions)) {
          continue;
        }
        const source = result.sessions;
        tracked.add(source);
        // Count complete source enumeration independently of reducer implementation and timing.
        Object.defineProperty(source, Symbol.iterator, {
          configurable: true,
          *value() {
            // Array values bypass this replaced iterator.
            for (const row of source.values()) {
              visitedRows += 1;
              yield row;
            }
          },
        });
      }
      return held.reduce((count, result) => count + (result?.sessions.length ?? 0), 0);
    };
    try {
      await sessions.refresh({ agentId: "main", force: true });
      for (const query of queries) {
        await sessions.refreshList({ ...query, force: true });
      }
      descriptor = sessions.observeRow({ key: target.key, agentId: "main" }, observed, {
        onEvent: eventDelivered,
      });
      observed.mockClear();
      const payload = {
        sessionKey: target.key,
        agentId: "main",
        sessionId: target.sessionId,
        reason: "update",
        label: "Shared updated",
        updatedAt: 2,
      };
      const heldRowCount = trackHeldRows();
      visitedRows = 0;
      const event = { type: "event" as const, event: "sessions.changed", payload };
      emitEvent(event);
      const expected = expect.objectContaining({ label: payload.label, updatedAt: 2 });
      // Allow per-view reduction and decoration; repeated whole-roster preparation is quadratic.
      expect(visitedRows).toBeLessThanOrEqual(heldRowCount * 12);
      expect(descriptor.row).toEqual(expected);
      for (const result of heldResults()) {
        expect(result?.sessions).toHaveLength(rows.length);
        expect(findTarget(result)).toEqual(expected);
      }
      expect(eventDelivered).toHaveBeenCalledExactlyOnceWith(
        event,
        expect.objectContaining({
          applied: true,
          admittedRow: expected,
          row: expected,
        }),
      );
      expect(eventDelivered).toHaveReturnedWith({
        descriptor: expected,
        rows: Array.from({ length: queries.length + 1 }, () => expected),
      });
      expect(observed).toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(queries.length + 1);
    } finally {
      descriptor?.dispose();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      sessions.dispose();
    }
  });

  it("converges an unrelated row before managed listeners run through Gateway reconciliation", async () => {
    const first = makeRow("first", "Shared first");
    const second = { ...makeRow("second", "Shared second"), lastMessagePreview: "Before" };
    const olderQuery = { agentId: "main", search: "Shared", limit: 10 };
    const newerQuery = { agentId: "main", search: "Shared", limit: 11 };
    let fresh = false;
    const { sessions, emitEvent, request } = makeHarness((params) => {
      const newer = fresh && asNullableRecord(params)?.limit === newerQuery.limit;
      return sessionsResult(
        [{ ...first }, { ...second, lastMessagePreview: newer ? "After" : "Before" }],
        1,
      );
    });
    let observe = false;
    const delivered: Array<{
      older: string | null | undefined;
      newer: string | null | undefined;
    }> = [];
    const preview = (query: typeof olderQuery) =>
      sessions.listSnapshot(query).result?.sessions.find((row) => row.key === second.key)
        ?.lastMessagePreview;
    const unsubscribeOlder = sessions.subscribeList(olderQuery, () => {
      if (observe) {
        delivered.push({ older: preview(olderQuery), newer: preview(newerQuery) });
      }
    });
    const unsubscribeNewer = sessions.subscribeList(newerQuery, () => undefined);
    const emitPatch = (label: string, updatedAt: number) =>
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: first.key,
          agentId: "main",
          reason: "patch",
          sessionId: first.sessionId,
          label,
          updatedAt,
        },
      });
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList({ ...olderQuery, force: true });
      await sessions.refreshList({ ...newerQuery, force: true });
      emitPatch(first.label, 1);
      fresh = true;
      await sessions.refreshList({ ...newerQuery, force: true });
      expect(preview(olderQuery)).toBe("Before");
      expect(preview(newerQuery)).toBe("After");
      const beforeRequests = request.mock.calls.length;
      observe = true;
      const label = "Shared first updated";
      emitPatch(label, 2);
      expect(delivered).toEqual([{ older: "After", newer: "After" }]);
      for (const query of [olderQuery, newerQuery]) {
        expect(sessions.listSnapshot(query).result?.sessions).toHaveLength(2);
        expect(
          sessions.listSnapshot(query).result?.sessions.find((row) => row.key === first.key)?.label,
        ).toBe(label);
      }
      expect(request).toHaveBeenCalledTimes(beforeRequests);
    } finally {
      unsubscribeOlder();
      unsubscribeNewer();
      sessions.dispose();
    }
  });
});
