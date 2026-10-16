/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  deleteSessionPlacementDraft,
  startSessionPlacementInitialTurn,
} from "./session-placement-startup.ts";

const targetKey = { key: "agent:cloud:test", agentId: "cloud" };
const params = {
  ...targetKey,
  target: { kind: "profile", profileId: "aws" } as const,
  message: "run remotely",
  mode: "dispatch" as const,
};

function clientWith(
  request: ReturnType<typeof vi.fn>,
): Parameters<typeof startSessionPlacementInitialTurn>[0] {
  const client = { request: request as GatewayBrowserClient["request"] };
  return {
    client,
    describe: (target) => client.request("sessions.describe", target),
  };
}

function start(
  request: ReturnType<typeof vi.fn>,
  overrides: Partial<Parameters<typeof startSessionPlacementInitialTurn>[1]> = {},
  current = () => true,
  beforeSend?: () => boolean,
) {
  return startSessionPlacementInitialTurn(
    clientWith(request),
    { ...params, ...overrides },
    current,
    beforeSend,
  );
}

function replies(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    if (value instanceof Error) {
      request.mockRejectedValueOnce(value);
    } else {
      request.mockResolvedValueOnce(value);
    }
  }
  return request;
}

function deleteDraft(request: ReturnType<typeof vi.fn>, recovered = false) {
  return deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId, recovered);
}

function placement(state: string, environmentId = "environment-1") {
  return { placement: { state, environmentId } };
}

function fakeTimers() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function expectReclaim(request: ReturnType<typeof vi.fn>, call: number) {
  expect(request).toHaveBeenNthCalledWith(call, "sessions.reclaim", targetKey);
}

function expectNotSent(request: ReturnType<typeof vi.fn>) {
  expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
}

describe("session placement startup", () => {
  it.each([
    {
      name: "profile",
      target: {
        kind: "profile",
        profileId: "aws",
        os: "windows/wsl2",
        machineClass: "fast",
      } as const,
      expectedTarget: { profileId: "aws", os: "windows/wsl2", machineClass: "fast" },
    },
    {
      name: "device",
      target: { kind: "device", deviceId: "device-1" } as const,
      expectedTarget: { deviceId: "device-1" },
    },
    {
      name: "automatic device",
      target: { kind: "auto-device" } as const,
      expectedTarget: { autoDevice: true },
    },
  ])("serializes a $name target to the flat dispatch contract", async (testCase) => {
    const request = replies(placement("active", "worker"), { runId: "run-target" });

    await expect(start(request, { target: testCase.target })).resolves.toMatchObject({
      status: "started",
    });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.dispatch", {
      ...targetKey,
      ...testCase.expectedTarget,
    });
  });

  it("does not reconcile a definitive dispatch rejection", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown cloud profile",
        retryable: false,
      }),
    );

    await expect(start(request)).resolves.toEqual({
      status: "dispatch-rejected",
      error: "unknown cloud profile",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());
  });

  it("reclaims an allocated worker when provisioning becomes failed", async () => {
    fakeTimers();
    const request = replies(
      placement("provisioning", "environment-failed"),
      { session: placement("failed", "environment-failed") },
      { ok: true },
    );

    const outcome = start(request);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({
      status: "dispatch-rejected",
      error: "session placement became failed",
    });
    expectReclaim(request, 3);
    expectNotSent(request);
  });

  it("keeps recovery state when failed-placement cleanup is rejected", async () => {
    const request = replies(
      placement("failed", "environment-failed"),
      new Error("cleanup unavailable"),
    );

    await expect(start(request)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
  });

  it("waits through absent placement after an ambiguous dispatch error", async () => {
    const attachments = [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }];
    fakeTimers();
    const request = replies(new Error("transport closed"));
    request.mockResolvedValueOnce({ session: {} });
    request
      .mockResolvedValueOnce({ session: placement("active", "environment-1") })
      .mockResolvedValueOnce({ runId: "run-1" });

    const outcome = start(request, { attachments });
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.describe", { key: params.key });
    expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
    expect(request).toHaveBeenNthCalledWith(
      4,
      "sessions.send",
      expect.objectContaining({ message: params.message, attachments }),
    );
  });

  it("continues provisioning after a Gateway restart without reclaiming the worker", async () => {
    vi.useFakeTimers();
    try {
      let unavailableReads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.dispatch") {
          return { placement: { state: "provisioning" } };
        }
        if (method === "sessions.describe") {
          if (unavailableReads++ < 8) {
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "Gateway temporarily unavailable",
              retryable: true,
              details: { reason: "gateway-restarting" },
            });
          }
          return { session: { placement: { state: "active" } } };
        }
        return { status: "started" };
      });
      const outcome = start(request);
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toMatchObject({ status: "started" });
      expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "reclaims the session placement",
      cleanupError: undefined,
      expectedError: "session placement could not be verified",
    },
    {
      name: "reports a rejected worker cleanup",
      cleanupError: "cleanup unavailable",
      expectedError: "session placement could not be verified; cleanup failed: cleanup unavailable",
    },
  ])("$name when placement lookups remain unavailable", async ({ cleanupError, expectedError }) => {
    vi.useFakeTimers();
    try {
      const request = replies(
        placement("provisioning", "environment-unavailable"),
        new Error("lookup unavailable 1"),
        new Error("lookup unavailable 2"),
        new Error("lookup unavailable 3"),
        new Error("lookup unavailable 4"),
      );
      if (cleanupError) {
        request.mockRejectedValueOnce(new Error(cleanupError));
      } else {
        request.mockResolvedValueOnce({ worker: { state: "destroyed" } });
      }

      const outcome = start(request);
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toEqual({ status: "cleanup-rejected", error: expectedError });
      expect(request).toHaveBeenCalledTimes(6);
      expectReclaim(request, 6);
      expect(request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["pending", "pending then unavailable"] as const)(
    "explains an unfinished placement without discarding it when the Gateway is %s",
    async (observation) => {
      vi.useFakeTimers();
      try {
        const pending = { state: "provisioning", environmentId: "environment-slow" };
        const request = vi.fn();
        if (observation === "pending") {
          request.mockResolvedValue({ session: { placement: pending } });
        } else {
          request.mockRejectedValue(
            new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "gateway restarting",
              retryable: true,
              details: { reason: "gateway-restarting" },
            }),
          );
        }
        request.mockResolvedValueOnce({ session: { placement: pending } });

        const outcome = start(request, { mode: "recover" });
        await vi.runAllTimersAsync();
        await expect(outcome).resolves.toEqual({
          status: "cleanup-rejected",
          error:
            observation === "pending"
              ? "Worker setup is still in progress. Retry to check the existing worker; your message has not been sent."
              : "Could not confirm whether worker setup finished. Retry to check again; your message has not been sent.",
        });
        expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
        expectNotSent(request);
        expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a cancelled placement recoverable when reclaim fails", async () => {
    const request = replies(placement("active"), new Error("cleanup unavailable"));

    await expect(start(request, {}, () => false)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
    expectReclaim(request, 2);
    expectNotSent(request);
  });

  it("reclaims by session when cancellation coincides with a lookup failure", async () => {
    fakeTimers();
    let current = true;
    const request = replies(placement("provisioning"))
      .mockImplementationOnce(async () => {
        current = false;
        throw new Error("reconnecting");
      })
      .mockResolvedValueOnce({ ok: true });

    const outcome = start(request, {}, () => current);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expectReclaim(request, 3);
  });

  it("reclaims without carrying an environment identity", async () => {
    fakeTimers();
    let current = true;
    const request = replies(placement("provisioning"))
      .mockImplementationOnce(async () => {
        current = false;
        return { session: { placement: { state: "provisioning" } } };
      })
      .mockResolvedValueOnce({ ok: true });

    const outcome = start(request, {}, () => current);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expectReclaim(request, 3);
  });

  it("keeps the accepted message identity when post-send cleanup fails", async () => {
    let current = true;
    const request = replies(placement("active"))
      .mockImplementationOnce(async (_method, requestParams) => {
        current = false;
        return { runId: "run-1", requestParams };
      })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    const outcome = await start(request, {}, () => current);
    const sent = request.mock.calls[1]?.[1] as { idempotencyKey: string };
    expect(outcome).toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
      messageId: sent.idempotencyKey,
    });
  });

  it("reclaims the worker after a definitive first-turn rejection", async () => {
    const request = replies(
      placement("active"),
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "message rejected",
        retryable: false,
      }),
      { ok: true },
    );

    await expect(start(request)).resolves.toEqual({
      status: "send-definitive-rejected",
      error: "message rejected",
      messageId: expect.any(String),
    });
    expectReclaim(request, 3);
  });

  it("reclaims the worker without sending when recovery cannot enter the sending phase", async () => {
    const request = replies(placement("active"), { ok: true });

    await expect(
      start(
        request,
        { messageId: "message-retained" },
        () => true,
        () => false,
      ),
    ).resolves.toEqual({
      status: "send-not-started",
      messageId: "message-retained",
      error: "placement recovery storage is unavailable",
    });
    expectReclaim(request, 2);
    expectNotSent(request);
  });

  it("preserves send-not-started classification when cleanup fails", async () => {
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({ placement: { state: "active" } });
      }
      if (method === "sessions.send") {
        return Promise.reject(new Error("gateway not connected"));
      }
      if (method === "sessions.reclaim") {
        return Promise.reject(new Error("cleanup unavailable"));
      }
      throw new Error(`unexpected method ${method}`);
    });
    await expect(start(request, { messageId: "retained" })).resolves.toEqual({
      status: "send-not-started",
      messageId: "retained",
      error: "gateway not connected; cleanup failed: cleanup unavailable",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.dispatch",
      "sessions.send",
      "sessions.reclaim",
    ]);
  });

  it("unarchives a local draft after a delete no-op", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-draft" } };
      }
      if (method === "sessions.delete") {
        return { ok: true, deleted: false };
      }
      return { ok: true };
    });

    await expect(deleteDraft(request)).resolves.toBe("placement draft session was not deleted");
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      ...targetKey,
      archived: false,
      expectedSessionId: "session-draft",
    });
  });

  it("reports both delete and restore failures during local draft cleanup", async () => {
    let patchCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-draft" } };
      }
      if (method === "sessions.delete") {
        throw new Error("delete unavailable");
      }
      patchCalls += 1;
      if (patchCalls === 2) {
        throw new Error("restore unavailable");
      }
      return { ok: true };
    });

    await expect(deleteDraft(request)).resolves.toBe(
      "delete unavailable; restoring the placement draft failed: restore unavailable",
    );
  });

  it("reclaims a recovered worker before archiving and deleting its draft session", async () => {
    const request = replies(
      {
        session: {
          sessionId: "session-recovered",
          placement: { state: "active", environmentId: "environment-recovered" },
        },
      },
      { ok: true },
      { ok: true },
      { ok: true, deleted: true },
    );

    await expect(deleteDraft(request, true)).resolves.toBeUndefined();
    const draftTarget = { ...targetKey, expectedSessionId: "session-recovered" };
    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: params.key }],
      ["sessions.reclaim", { key: params.key, agentId: params.agentId }],
      [
        "sessions.patch",
        {
          ...draftTarget,
          archived: true,
        },
      ],
      [
        "sessions.delete",
        {
          ...draftTarget,
          deleteTranscript: true,
          archivedOnly: true,
        },
      ],
    ]);
  });

  it("retains a recovered draft when worker placement cannot be verified", async () => {
    const request = replies(new Error("gateway unavailable"));

    await expect(deleteDraft(request, true)).resolves.toBe(
      "session placement could not be verified",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.describe", { key: params.key });
  });

  it("treats a missing recovered session as already cleaned up", async () => {
    const request = replies({ session: null });

    await expect(deleteDraft(request, true)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns the same idempotency key when first-turn sending fails", async () => {
    const request = replies(placement("active"), new Error("transport closed"));

    const outcome = await start(request);
    expect(outcome).toMatchObject({ status: "send-rejected", error: "transport closed" });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.send",
      expect.objectContaining({
        key: params.key,
        message: params.message,
        idempotencyKey: (outcome as { messageId: string }).messageId,
      }),
    );
  });
});
