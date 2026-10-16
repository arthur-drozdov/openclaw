import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { SystemAgentTurnRunner } from "./agent-turn.js";
import {
  fakeOverviewLoader,
  sharedVerifiedInference,
  classifySystemAgentApprovalText,
  mocks,
  useTempStateDir,
  SystemAgentChatEngine,
  SystemAgentInferenceUnavailableError,
  expectDefined,
  hashSystemAgentOperation,
} from "./chat-engine.test-support.js";
import { ChatTurnRouter } from "./chat-turn-router.js";
import { ChatWizardHost } from "./chat-wizard-host.js";
import { describeSystemAgentPersistentOperation } from "./operations.js";

type EngineOptions = ConstructorParameters<typeof SystemAgentChatEngine>[0];
function createEngine(options: EngineOptions = {}) {
  return new SystemAgentChatEngine({
    ...options,
    deps: { loadOverview: fakeOverviewLoader(), ...options.deps },
  });
}

function commandHarness(text: string, options: EngineOptions = {}) {
  const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text }));
  return { runAgentTurn, engine: createEngine({ runAgentTurn, ...options }) };
}

const approveYes: NonNullable<EngineOptions["classifyApproval"]> = async ({ message }) =>
  message === "yes" ? "approve" : "other";
const classifyText: NonNullable<EngineOptions["classifyApproval"]> = async ({ message }) =>
  classifySystemAgentApprovalText(message);

function expectText(text: string | undefined, contains: string[], excludes: string[] = []) {
  for (const value of contains) {
    expect(text).toContain(value);
  }
  for (const value of excludes) {
    expect(text).not.toContain(value);
  }
}

const portChange = { kind: "config-set", path: "gateway.port", value: "19001" } as const;
const agentCreation = {
  kind: "create-agent",
  agentId: "researcher",
  workspace: "/tmp/researcher",
} as const;

function createRouterHarness(options: ConstructorParameters<typeof ChatTurnRouter>[0]) {
  const verifiedInference = expectDefined(
    sharedVerifiedInference,
    "shared verified inference test fixture",
  );
  const session = {
    sessionId: "approval-router-test",
    verifiedInference,
    proposalRef: {},
  };
  return new ChatTurnRouter(
    options,
    { executeOperation: async () => ({ applied: true }) },
    session,
    new ChatWizardHost({ beforePersistentApply: async () => {} }),
    {
      requireVerifiedInference: async () => verifiedInference.execution,
      requirePersistentApplyInference: async () => verifiedInference.execution,
      rebindVerifiedInference: () => {},
      getVerifiedInference: () => verifiedInference,
      loadOverview: fakeOverviewLoader(),
      verifyConfigAfterWrite: async () => null,
    },
  );
}

describe("SystemAgentChatEngine approval", () => {
  it("records the delegated requester before hashing a model-tool proposal", async () => {
    const unrecordedHash = hashSystemAgentOperation(agentCreation);
    const router = createRouterHarness({
      operatorApprovalOnly: true,
      requesterAgentId: "research",
      runAgentTurn: async ({ session }) => {
        session.proposalRef.current = unrecordedHash;
        session.proposalRef.operation = agentCreation;
        return { text: "Creation needs operator approval." };
      },
    });

    await router.resolveTurn("Create a research agent.");
    const proposal = expectDefined(router.getPendingOperatorProposal(), "delegated proposal");

    expect(proposal.operation).toEqual({
      ...agentCreation,
      requesterAgentId: "research",
    });
    expect(proposal.hash).not.toBe(unrecordedHash);
    expect(describeSystemAgentPersistentOperation(proposal.operation)).toContain(
      "requested by agent research",
    );
    expect(await router.resolveOperatorApproval("allow-once", unrecordedHash)).toBeNull();
    expect(await router.resolveOperatorApproval("allow-once", proposal.hash)).not.toBeNull();
    expect(router.getPendingOperatorProposal()).toBeNull();
  });

  it.each(["allow-once", null] as const)(
    "resolves delegated persistent writes only from the operator decision %s",
    async (decision) => {
      useTempStateDir();
      const proposalHash = hashSystemAgentOperation(portChange);
      const runConfigSet = vi.fn(async () => {});
      const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async ({ session }) => {
        if (runAgentTurn.mock.calls.length === 1) {
          session.proposalRef.current = proposalHash;
          session.proposalRef.operation = portChange;
        }
        return { text: "Change ready." };
      });
      const engine = createEngine({
        operatorApprovalOnly: true,
        runAgentTurn,
        deps: { runConfigSet },
      });

      await engine.handle("Change port.");
      const agentApproval = await engine.handle("yes");

      expect(agentApproval.text).toContain("Approval pending");
      expect(runAgentTurn.mock.calls.map(([params]) => params.approvalArmed)).toEqual([false]);
      expect(runConfigSet).not.toHaveBeenCalled();

      const wrongProposal = await engine.resolveOperatorApproval("allow-once", "wrong-hash");
      expect(wrongProposal).toBeNull();
      expect(runConfigSet).not.toHaveBeenCalled();

      const applied = await engine.resolveOperatorApproval(decision, proposalHash);
      const duplicate = await engine.resolveOperatorApproval(decision, proposalHash);
      await engine.handle("what changed?");

      expect(runAgentTurn.mock.calls.map(([params]) => params.approvalArmed)).toEqual([
        false,
        false,
      ]);
      expect(duplicate).toBeNull();
      const resolvedInput = runAgentTurn.mock.calls[1]?.[0].input;
      expectText(resolvedInput, ["[proposal-resolved]"], ["host-seeded"]);
      if (decision === "allow-once") {
        expect(runConfigSet).toHaveBeenCalledOnce();
        expect(runConfigSet).toHaveBeenCalledWith({
          path: "gateway.port",
          value: "19001",
          cliOptions: {},
        });
        expect(applied?.text).toContain("[openclaw] done: config.set");
        expect(resolvedInput).toContain("was approved");
      } else {
        expect(runConfigSet).not.toHaveBeenCalled();
        expect(applied?.text).toBe("Denied. No change.");
        expect(resolvedInput).toContain("was declined");
      }
    },
  );

  it.each([
    [undefined, "openclaw", ""],
    ["research", "research", ", requested by agent research"],
  ] as const)(
    "hatches an agent requested by %s with approval-bound provenance",
    async (requesterAgentId, expectedCreatorAgentId, descriptionSuffix) => {
      useTempStateDir();
      const createAgent = vi.fn(async () => ({
        status: "created" as const,
        agentId: "researcher",
        name: "researcher",
        workspace: "/tmp/researcher",
        agentDir: "/tmp/agent-researcher",
        bootstrapPending: true,
        config: {},
        configPath: "/tmp/openclaw.json",
      }));
      const engine = createEngine({
        runAgentTurn: async () => ({ text: "noted" }),
        classifyApproval: approveYes,
        deps: { createAgent },
        ...(requesterAgentId ? { requesterAgentId, operatorApprovalOnly: true } : {}),
      });
      engine.propose(agentCreation);
      const proposal = expectDefined(engine.getPendingOperatorProposal(), "create-agent proposal");

      expect(proposal.operation).toEqual({
        ...agentCreation,
        ...(requesterAgentId ? { requesterAgentId } : {}),
      });
      expect(describeSystemAgentPersistentOperation(proposal.operation)).toBe(
        "create agent researcher with workspace /tmp/researcher" + descriptionSuffix,
      );

      const reply = expectDefined(
        await engine.resolveOperatorApproval("allow-once", proposal.hash),
        "approved create-agent reply",
      );

      expect(createAgent).toHaveBeenCalledWith({
        entry: { id: "researcher" },
        workspace: "/tmp/researcher",
        provenance: { createdVia: "agent", creatorAgentId: expectedCreatorAgentId },
      });
      expect(reply).toMatchObject({
        action: "open-tui",
        handoff: { kind: "open-tui", agentId: "researcher", agentDraft: "hatch" },
      });
    },
  );

  it("stays in setup when post-write verification flags the config", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: true,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/hatch-work"],
    }));
    // Invalidate only after the write, so preflight still passes.
    const validSnapshot = mocks.readConfigFileSnapshot.getMockImplementation()!;
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      const snapshot = await validSnapshot();
      return applySetup.mock.calls.length > 0
        ? ({
            ...snapshot,
            valid: false,
            issues: [{ path: "agents", message: "broken" }],
          } as never)
        : snapshot;
    });
    const engine = createEngine({
      runAgentTurn: async () => ({ text: "repair suggestion" }),
      classifyApproval: approveYes,
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).not.toContain("Your agent is hatching");
  });

  it("keeps provider setup non-mutating and directs the operator to Models", async () => {
    const { engine } = commandHarness("noted", { surface: "gateway" });

    const reply = await engine.handle("configure model provider workspace /tmp/gateway-work");

    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.sensitive).toBeUndefined();
    expectText(
      reply.text,
      ["Settings → Models → Connect provider", "Connecting another provider does not select it"],
      ["openclaw onboard"],
    );
  });

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose(portChange);

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it("voids an agent-loop proposal on decline and lets the AI acknowledge", async () => {
    let observedProposalOnSecondTurn: string | undefined = "sentinel";
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async ({ session }) => {
      if (runAgentTurn.mock.calls.length === 1) {
        session.proposalRef.current = "registered-operation";
        return { text: "I can change that after your approval." };
      }
      observedProposalOnSecondTurn = session.proposalRef.current;
      return { text: "Okay, leaving it as is." };
    });
    const router = createRouterHarness({
      runAgentTurn,
      classifyApproval: classifyText,
    });

    await router.resolveTurn("change the model");
    const declined = await router.resolveTurn("no thanks");

    // A later generic approval must not arm the declined mutation.
    expect(observedProposalOnSecondTurn).toBeUndefined();
    expect(declined.text).toContain("leaving it as is");
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("clears a stale host proposal once the agent loop owns the conversation", async () => {
    const operation = { kind: "config-set", path: "gateway.port", value: "19002" } as const;
    const hash = hashSystemAgentOperation(operation);
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
      params.session.proposalRef.current = hash;
      params.session.proposalRef.operation = operation;
      return { text: "loop reply" };
    });
    const router = createRouterHarness({
      runAgentTurn,
      classifyApproval: classifyText,
    });
    router.propose(portChange);

    await router.resolveTurn("actually, tell me about workspaces first");

    expect(router.getPendingOperatorProposal()).toEqual({ operation, hash });
    await router.resolveTurn("yes");

    expect(runAgentTurn.mock.calls.map(([params]) => params.approvalArmed)).toEqual([false, true]);
    expect(runAgentTurn.mock.calls[1]?.[0].input).not.toContain("host-seeded");
  });

  it("keeps a host setup proposal across approval reads and follow-up questions", async () => {
    const operation = { kind: "setup", workspace: "/tmp/work", model: "openai/gpt-5.5" } as const;
    const proposal = { operation, hash: hashSystemAgentOperation(operation) };
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({
      text: "A workspace is where your agent keeps its project files.",
    }));
    const router = createRouterHarness({
      runAgentTurn,
      classifyApproval: classifyText,
    });
    router.propose(operation);

    expect(router.getPendingOperatorProposal()).toEqual(proposal);
    expect(router.getPendingOperatorProposal()).toEqual(proposal);

    await router.resolveTurn("what does workspace mean?");

    expect(router.getPendingOperatorProposal()).toEqual(proposal);
    expectText(runAgentTurn.mock.calls[0]?.[0].input, [
      '"model":"openai/gpt-5.5"',
      "Keep the verified model",
    ]);

    await router.resolveTurn("yes");

    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(router.getPendingOperatorProposal()).toBeNull();
  });

  it("keeps a host-resolution marker queued across a failed turn", async () => {
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text: "native reply" }));
    runAgentTurn.mockResolvedValueOnce(null);
    const router = createRouterHarness({
      runAgentTurn,
      classifyApproval: approveYes,
    });
    router.propose(portChange);

    await router.resolveTurn("yes");
    await expect(router.resolveTurn("what next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    await router.resolveTurn("try the native session again");
    await router.resolveTurn("and now?");

    const observedInputs = runAgentTurn.mock.calls.map(([params]) => params.input);
    expect(observedInputs).toHaveLength(3);
    expect(observedInputs[0]).toContain("was approved");
    expect(observedInputs[1]).toContain("was approved");
    expect(observedInputs[2]).not.toContain("proposal-resolved");
  });

  it.each([
    [
      'channels.synology-chat.accounts["prod.guild"].webhookUrl',
      "https://gateway.example/webhook/synology?access_token=very-secret",
    ],
    ["plugins.entries.codex.config.appServer.headers.Authorization", "Bearer very-secret"],
    [
      "channels.synology-chat",
      '{ webhookUrl: "https://gateway.example/webhook/synology?access_token=very-secret" }',
    ],
  ])(
    "keeps hint-sensitive config writes at %s away from model paths and history",
    async (path, value) => {
      useTempStateDir();
      const runConfigSet = vi.fn(async () => {});
      const { engine, runAgentTurn } = commandHarness("still pending", { deps: { runConfigSet } });

      const proposed = await engine.handle(`config set ${path} ${value}`);

      expect(runAgentTurn).not.toHaveBeenCalled();
      expectText(proposed.text, ["<redacted>"], ["very-secret"]);
      expect(engine.getPendingOperatorProposal()?.operation).toEqual({
        kind: "config-set",
        path,
        value,
      });

      await engine.handle("what is that setting?");
      expectText(runAgentTurn.mock.calls[0]?.[0].input, ["<redacted>"], ["very-secret"]);

      const applied = await engine.handle("yes");
      expect(runConfigSet).toHaveBeenCalledOnce();
      expect(applied.text).toContain("[openclaw] done: config.set");
      expectText(JSON.stringify(engine.historySince(0)), ["<redacted secret>"], ["very-secret"]);
    },
  );

  it("keeps valid SecretRef ids out of pending context and later history", async () => {
    const rawRef = "123:actual-gateway-token";
    const { engine, runAgentTurn } = commandHarness("still pending", {
      classifyApproval: async () => "other",
      deps: { runConfigSet: vi.fn(async () => {}) },
    });

    const proposed = await engine.handle(`config set-ref gateway.auth.token exec ${rawRef}`);
    expect(proposed.text).not.toContain(rawRef);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "exec",
      id: rawRef,
    });
    await engine.handle("what will this change?");

    expectText(
      runAgentTurn.mock.calls.map(([params]) => params.input).join("\n"),
      ["<redacted>"],
      [rawRef],
    );
    expect(JSON.stringify(engine.historySince(0))).not.toContain(rawRef);
  });

  it("keeps malformed config read paths off model and history", async () => {
    const { engine, runAgentTurn } = commandHarness("should never run");

    const reply = await engine.handle('config schema gateway.auth["token=abcDEF123"]');

    expect(reply.text).toContain("Invalid config path");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(engine.historySince(0))).not.toContain("abcDEF123");
  });

  it("redacts vulnerable config command text when persisted history is seeded", () => {
    const engine = createEngine();

    engine.seedHistory([
      { role: "user", text: "config set-ref gateway.auth.token exec 123:actual-gateway-token" },
      { role: "user", text: "config get gateway.auth.tokenabcDEF123" },
    ]);

    expectText(JSON.stringify(engine.historySince(0)), [], ["actual-gateway-token", "abcDEF123"]);
  });

  it.each([
    "config set gateway.auth..token very-secret",
    "config set plugins.entries.codex.config.appServer.headers.Authorization=Bearer-abc please",
    "config set-ref gateway.auth.tokenabcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token env 123:actual-gateway-token",
  ])("keeps malformed sensitive config write %s away from every model path", async (command) => {
    useTempStateDir();
    const { engine, runAgentTurn } = commandHarness("should never run", {
      deps: { runConfigSet: vi.fn(async () => {}) },
    });

    const proposed = await engine.handle(command);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expectText(
      proposed.text,
      ["Invalid config path"],
      ["very-secret", "abcDEF123", "actual-gateway-token"],
    );
    expect(engine.getPendingOperatorProposal()).toBeNull();

    await engine.handle("did that work?");

    const userTurns = engine
      .historySince(0)
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text);
    for (const text of userTurns) {
      expectText(text, [], ["very-secret", "abcDEF123", "Bearer-abc", "actual-gateway-token"]);
    }
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });

  it.each([
    "config set plugins.entries.missing.config.opaque.abcDEF123 please",
    'config set channels.synology-chat.accounts["prod.guild"].webhookUrl.abcDEF123 please',
  ])(
    "keeps sensitive dynamic or unknown-owner path %s out of model paths, responses, and history",
    async (command) => {
      const { engine, runAgentTurn } = commandHarness("noted", {
        classifyApproval: async () => "other",
      });

      const proposed = await engine.handle(command);
      expectText(proposed.text, [], ["abcDEF123", "Bearer-abc"]);
      expect(runAgentTurn).not.toHaveBeenCalled();

      await engine.handle("no");
      await engine.handle("did that work?");
      for (const turn of engine.historySince(0)) {
        expectText(turn.text, [], ["abcDEF123", "Bearer-abc"]);
      }
    },
  );
});
