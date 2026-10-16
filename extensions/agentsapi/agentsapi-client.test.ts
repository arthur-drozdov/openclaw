import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentsApiClient,
  type AgentsApiArtifact,
  type AgentsApiInputFile,
} from "./agentsapi-client.js";
import { createTurn } from "./agentsapi.test-support.js";

const { guardedFetch } = vi.hoisted(() => ({
  guardedFetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

afterEach(() => {
  vi.unstubAllEnvs();
  guardedFetch.mockReset();
});

const signal = new AbortController().signal;
const sessionId = "session-fixture";
const turnId = "turn-fixture";
const functionCall = {
  type: "function_call" as const,
  turn_id: turnId,
  call_id: "call-fixture",
  name: "fixture_tool",
  arguments: {},
};

function connectionSession(type = "self_hosted", requestedId = "environment-fixture") {
  return {
    id: sessionId,
    status: "requires_action",
    error: null,
    environment: {
      type,
      id: "environment-fixture",
      workspace_directory: "/fixture/workspace",
      remote_url: "wss://executor.invalid/session-fixture",
    },
    required_actions: [{ type: "environment_connection", environment_id: requestedId }],
  };
}

function upload(client = createClient(), transferSignal = signal) {
  return client.uploadFile(sessionId, inputFile, transferSignal);
}

function listArtifacts() {
  return createClient().artifacts(sessionId, turnId, signal);
}

function download(metadata = artifact(), limit = 4) {
  return createClient().artifactContent(sessionId, metadata, limit, signal);
}

function authority(kind: string, defaultAbort = false) {
  const controller = new AbortController();
  const error = new Error("fixture authority ended");
  let current = true;
  return {
    controller,
    error,
    client: createClient(() => {
      if (!current) {
        throw error;
      }
    }),
    interrupt() {
      if (kind === "abort") {
        controller.abort(defaultAbort ? undefined : error);
      } else {
        current = false;
      }
    },
  };
}

describe("Agents API self-hosted session connection", () => {
  it.each([false, true])("connects self-hosted sessions (controller: %s)", async (controlled) => {
    const base = connectionSession();
    const session = { ...base, required_actions: [...base.required_actions, functionCall] };
    queueJson(session);
    queueJson(session);
    const client = createClient();
    expect((await client.session(sessionId, signal)).environment).toEqual(session.environment);
    const connect = vi.fn(async () => {});
    expect(
      await client.pendingFunctionCalls(sessionId, signal, controlled ? connect : undefined),
    ).toEqual([functionCall]);
    expect(connect.mock.calls).toEqual(controlled ? [["environment-fixture"]] : []);
  });

  it.each([
    { type: "openai_hosted", requestedId: "environment-fixture" },
    { type: "self_hosted", requestedId: "foreign-environment" },
  ])("rejects connection to $type/$requestedId", async ({ type, requestedId }) => {
    queueJson(connectionSession(type, requestedId));
    const client = createClient();
    const connect = vi.fn(async () => {});
    await expect(client.pendingFunctionCalls(sessionId, signal, connect)).rejects.toThrow(
      "cannot reconnect an environment_connection",
    );
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("Agents API session creation", () => {
  it.each([false, true])("creates sessions (custom tools: %s)", async (customTools) => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.9.1");
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      "User-Agent: fixture-client/1.0\nX-Attribution-Fixture: preserved",
    );
    queueJson({ id: sessionId });
    const gatewayFunction = {
      type: "function" as const,
      name: "message",
      description: "Send a fixture message",
      parameters: {},
    };
    const mcpTool = {
      type: "mcp" as const,
      server_label: "fixture",
      transport: { type: "http" as const, server_url: "https://mcp.example.test" },
    };

    const model = "future-model";
    const options = customTools
      ? { nativeTools: [], functions: [gatewayFunction], mcpTools: [mcpTool] }
      : undefined;
    await expect(
      createClient().create(signal, "Fixture instructions", model, options),
    ).resolves.toBe(sessionId);

    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const request = requestAt(0);
    const body: unknown = await request.json();
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(request.headers)).toMatchObject({
      "user-agent": "openclaw/2026.9.1",
      originator: "openclaw",
      version: "2026.9.1",
      authorization: "Bearer fixture-not-a-real-api-key",
      "x-stainless-lang": "js",
      "x-attribution-fixture": "preserved",
    });
    expect(body).toMatchObject({ agent: { model } });
    if (customTools) {
      expect(body).toHaveProperty("agent.tools", [mcpTool, gatewayFunction]);
    }
  });
});

describe("Agents API event submission retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("retries a tool result with the same payload and key, then gives a new submission its own key", async () => {
    queueResponse(serverError(500));
    queueResponse(serverError(503));
    queueResponse(new Response(null, { status: 202 }));
    const client = createClient();
    const submit = () =>
      client.toolResult(sessionId, functionCall, { success: true, output: "Saved result" }, signal);
    const result = expect(submit()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;

    const attempts = requests();
    const key = attempts[0]!.headers.get("Idempotency-Key");
    expect(key).toEqual(expect.stringMatching(/./u));
    expect(attempts.map((request) => request.headers.get("Idempotency-Key"))).toEqual(
      Array(3).fill(key),
    );
    const bodies = await Promise.all(attempts.map((request) => request.text()));
    expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);

    queueResponse(new Response(null, { status: 202 }));
    await submit();
    expect(requests().at(-1)!.headers.get("Idempotency-Key")).not.toBe(key);
  });

  it("stops after three server failures and preserves the last API error", async () => {
    for (const status of [500, 502, 504]) {
      queueResponse(serverError(status));
    }
    const result = expect(createClient().message(sessionId, "Hello", signal)).rejects.toMatchObject(
      { status: 504, message: expect.stringContaining("Failure 504") },
    );
    await vi.runAllTimersAsync();
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [429, undefined],
    [500, { "x-should-retry": "false" }],
  ] satisfies [number, HeadersInit | undefined][])(
    "does not retry HTTP %s with headers %j",
    async (status, headers) => {
      queueResponse(serverError(status, headers));
      await expect(createClient().message(sessionId, "Hello", signal)).rejects.toMatchObject({
        status,
      });
      expect(guardedFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["abort", "revoked ownership"])("stops retries after %s", async (interruption) => {
    queueResponse(serverError(500));
    const { client, controller, interrupt, error } = authority(interruption, true);
    const result = expect(client.message(sessionId, "Hello", controller.signal)).rejects.toThrow(
      interruption === "abort" ? "aborted" : error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    interrupt();
    await vi.runAllTimersAsync();
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });
});

const dormantUploadMessage =
  "the hosted environment is dormant; submit new input to start a fresh sandbox";

describe("Agents API file upload transport", () => {
  it.each(["uploaded", "unavailable"])("returns %s from a connected upload", async (status) => {
    queueUploadContext();
    queueJson(
      status === "uploaded"
        ? uploadReceipt
        : { error: { type: "conflict_error", message: dormantUploadMessage } },
      { status: status === "uploaded" ? 200 : 409 },
    );
    await expect(upload()).resolves.toEqual({ status });

    expect(guardedFetch).toHaveBeenCalledTimes(3);
    expect([requestAt(0), requestAt(1)].map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/agents/sessions/session-fixture",
      "/v1/agents/environments/environment-fixture",
    ]);
    const request = requestAt(2);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/agents/environments/environment-fixture/files");
    expect(request.headers.get("Idempotency-Key")).toEqual(expect.any(String));
    expect(await request.json()).toEqual(inputFile);
  });

  it.each([{ id: "environment-other", status: "disconnected" }, { status: "pending" }])(
    "refuses upload to environment %j",
    async (patch) => {
      queueUploadContext(patch);

      await expect(upload()).rejects.toThrow("requires the session's connected hosted environment");
      expect(guardedFetch).toHaveBeenCalledTimes(2);
      expect([requestAt(0).method, requestAt(1).method]).toEqual(["GET", "GET"]);
    },
  );

  it.each([
    ["different conflict", 409, "conflict_error", "Upload is busy"],
    ["wrong error type", 409, "invalid_request_error", dormantUploadMessage],
    ["permission failure", 403, "conflict_error", dormantUploadMessage],
    ["malformed error", 409, "conflict_error", [dormantUploadMessage]],
  ] satisfies [string, number, string, string | string[]][])(
    "preserves upload %s",
    async (_name, status, type, message) => {
      queueUploadContext();
      queueJson({ error: { type, message } }, { status });

      await expect(upload()).rejects.toMatchObject({ status, type, error: { type, message } });
    },
  );

  it.each(["abort", "revocation"])("rejects dormant responses after %s", async (interruption) => {
    queueUploadContext();
    const { client, controller, interrupt, error } = authority(interruption);
    const release = queueJson(
      { error: { type: "conflict_error", message: dormantUploadMessage } },
      { status: 409 },
    );
    release.mockImplementation(async () => interrupt());

    await expect(upload(client, controller.signal)).rejects.toThrow(error.message);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { environment_id: "environment-other" },
    { path: "/workspace/inputs/other.bin" },
    { size_bytes: 5 },
  ])("rejects mismatched receipt %j", async (patch) => {
    queueUploadContext();
    queueJson({ ...uploadReceipt, ...patch });

    await expect(upload()).rejects.toThrow(
      "did not match the requested environment, path, or size",
    );
  });
});

describe("Agents API immutable artifact metadata", () => {
  it("paginates using the complete page while returning only the requested turn's artifacts", async () => {
    const first = artifact({ id: "artifact-first" });
    const previousTurn = artifact({ id: "artifact-previous", turn_id: "turn-previous" });
    const last = artifact({ id: "artifact-last" });
    queueJson({ data: [first, previousTurn], has_more: true });
    queueJson({ data: [last], has_more: false });

    await expect(listArtifacts()).resolves.toEqual([first, last]);

    const initial = new URL(requestAt(0).url);
    expect(initial.pathname).toBe("/v1/agents/sessions/session-fixture/artifacts");
    expect(Object.fromEntries(initial.searchParams)).toEqual({ order: "asc", limit: "100" });
    expect(new URL(requestAt(1).url).searchParams.get("after")).toBe("artifact-previous");
  });

  it("rejects a foreign session artifact even when it belongs to a different turn", async () => {
    queueJson({
      data: [artifact({ session_id: "session-other", turn_id: "turn-previous" })],
      has_more: false,
    });

    await expect(listArtifacts()).rejects.toThrow("artifact outside the requested session");
  });

  it.each(["empty", "repeated"])("stops a %s continuation page", async (kind) => {
    if (kind === "repeated") {
      queueJson({ data: [artifact()], has_more: true });
    }
    queueJson({ data: kind === "empty" ? [] : [artifact()], has_more: true });

    await expect(listArtifacts()).rejects.toThrow("no valid continuation cursor");
    expect(guardedFetch).toHaveBeenCalledTimes(kind === "empty" ? 1 : 2);
  });

  it.each([
    { id: "turn-other" },
    { session_id: "session-other" },
    { subagent_id: "subagent-fixture" },
  ])("rejects foreign root-turn metadata %j", async (patch) => {
    queueJson(createTurn(patch));
    await expect(createClient().turn(sessionId, turnId, signal)).rejects.toThrow(
      "turn outside the requested root session",
    );
  });
});

describe("Agents API immutable artifact download", () => {
  it.each([
    { name: "truncated", bytes: [0, 255], message: "did not match its immutable size" },
    { name: "oversized", bytes: [0, 255, 128, 65, 9], message: "exceeded its immutable size" },
  ])("rejects $name content and releases the response", async ({ bytes, message }) => {
    const release = queueResponse(new Response(Uint8Array.from(bytes)));

    await expect(download()).rejects.toThrow(message);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "foreign session", metadata: { session_id: "session-other" }, limit: 4 },
    { name: "oversized metadata", metadata: { size_bytes: 5 }, limit: 4 },
    { name: "invalid byte budget", metadata: {}, limit: -1 },
  ])("rejects $name before opening a download", async ({ metadata, limit }) => {
    await expect(download(artifact(metadata), limit)).rejects.toThrow(
      "exceeds its session or byte bounds",
    );
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each(["abort", "revocation"])("cancels pending content after %s", async (interruption) => {
    const { client, controller, interrupt, error } = authority(interruption);
    const contentRequested = createDeferred<void>();
    const cancel = vi.fn();
    let content!: ReadableStreamDefaultController<Uint8Array>;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start(streamController) {
          content = streamController;
        },
        pull(streamController) {
          if (reads++ === 0) {
            streamController.enqueue(Uint8Array.from([0]));
          } else {
            contentRequested.resolve();
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const release = queueResponse(new Response(body));
    const result = client.artifactContent(sessionId, artifact(), 4, controller.signal);
    const rejection = expect(result).rejects.toThrow(error.message);
    await contentRequested.promise;
    interrupt();
    content.enqueue(Uint8Array.from([255]));

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

const inputFile: AgentsApiInputFile = {
  type: "inline",
  path: "/workspace/inputs/fixture.bin",
  data: "AP+AQQ==",
};

const uploadReceipt = {
  environment_id: "environment-fixture",
  path: "/workspace/inputs/fixture.bin",
  size_bytes: 4,
};

function createClient(assertCurrent: () => void = () => {}) {
  return new AgentsApiClient("fixture-not-a-real-api-key", assertCurrent);
}

function queueResponse(response: Response) {
  const release = vi.fn(async () => {});
  guardedFetch.mockImplementationOnce(async (request) => {
    request.beforeRequest?.();
    return { response, finalUrl: request.url, release };
  });
  return release;
}

function queueUploadContext(environment: { id?: string; status?: string } = {}) {
  const hosted = { type: "openai_hosted", id: "environment-fixture" };
  queueJson({ id: sessionId, environment: hosted });
  queueJson({ ...hosted, status: "connected", ...environment });
}

function requestAt(index: number) {
  return requests()[index]!;
}

function artifact(overrides: Partial<AgentsApiArtifact> = {}): AgentsApiArtifact {
  return {
    id: "artifact-fixture",
    object: "agent.session.artifact",
    session_id: "session-fixture",
    environment_id: "environment-fixture",
    turn_id: "turn-fixture",
    path: "/workspace/outputs/fixture.bin",
    size_bytes: 4,
    ...overrides,
  };
}

function queueJson(body: unknown, init?: ResponseInit) {
  return queueResponse(Response.json(body, init));
}

function serverError(status: number, headers?: HeadersInit) {
  return Response.json({ error: { message: `Failure ${status}` } }, { status, headers });
}

function requests() {
  return guardedFetch.mock.calls.map(([request]) => new Request(request.url, request.init));
}
