import "./chat-engine.mocks.test-support.js";
import { expect, it, vi } from "vitest";
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
  contains.forEach((value) => expect(text).toContain(value));
  excludes.forEach((value) => expect(text).not.toContain(value));
}

const portChange = { kind: "config-set", path: "gateway.port", value: "19001" } as const;
const workspace = "/tmp/researcher";
const agentCreation = { kind: "create-agent", agentId: "researcher", workspace } as const;

function createRouterHarness(options: ConstructorParameters<typeof ChatTurnRouter>[0]) {
  const verifiedInference = expectDefined(sharedVerifiedInference, "verified inference fixture");
  return new ChatTurnRouter(
    options,
    { executeOperation: async () => ({ applied: true }) },
    { sessionId: "approval-router-test", verifiedInference, proposalRef: {} },
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
    expect(runAgentTurn.mock.calls.map(([params]) => params.approvalArmed)).toEqual([false, false]);
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
  ["host", undefined, "openclaw", ""],
  ["host", "research", "research", ", requested by agent research"],
  ["model", "research", "research", ", requested by agent research"],
] as const)(
  "hatches a %s proposal from %s with approval-bound provenance",
  async (source, requesterAgentId, expectedCreatorAgentId, descriptionSuffix) => {
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
    const unrecordedHash = hashSystemAgentOperation(agentCreation);
    const engine = createEngine({
      runAgentTurn: async ({ session }) => {
        session.proposalRef.current = unrecordedHash;
        session.proposalRef.operation = agentCreation;
        return { text: "Creation needs operator approval." };
      },
      classifyApproval: approveYes,
      deps: { createAgent },
      ...(requesterAgentId ? { requesterAgentId, operatorApprovalOnly: true } : {}),
    });
    if (source === "model") {
      await engine.handle("Create a research agent.");
    } else {
      engine.propose(agentCreation);
    }
    const proposal = expectDefined(engine.getPendingOperatorProposal(), "create-agent proposal");
    expect(proposal.operation).toEqual({
      ...agentCreation,
      ...(requesterAgentId ? { requesterAgentId } : {}),
    });
    if (source === "model") {
      expect(proposal.hash).not.toBe(unrecordedHash);
      expect(await engine.resolveOperatorApproval("allow-once", unrecordedHash)).toBeNull();
    }
    expect(describeSystemAgentPersistentOperation(proposal.operation)).toBe(
      "create agent researcher with workspace /tmp/researcher" + descriptionSuffix,
    );

    const reply = await engine.resolveOperatorApproval("allow-once", proposal.hash);
    expect(createAgent).toHaveBeenCalledWith({
      entry: { id: "researcher" },
      workspace: "/tmp/researcher",
      provenance: { createdVia: "agent", creatorAgentId: expectedCreatorAgentId },
    });
    expect(engine.getPendingOperatorProposal()).toBeNull();
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

  expect((await engine.handle("no thanks")).text).toContain("Skipped");
  expect(runConfigSet).not.toHaveBeenCalled();
  expect(engine.getPendingOperatorProposal()).toBeNull();
});

it.each(["agent-decline", "agent-replaces-host", "host-setup"] as const)(
  "preserves proposal ownership through %s",
  async (mode) => {
    const operation =
      mode === "host-setup"
        ? { kind: "setup" as const, workspace: "/tmp/work", model: "openai/gpt-5.5" }
        : { kind: "config-set" as const, path: "gateway.port", value: "19002" };
    const hash = hashSystemAgentOperation(operation);
    const proposal = { operation, hash };
    let observedProposal: string | undefined = "sentinel";
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async ({ session }) => {
      if (mode === "agent-decline" && runAgentTurn.mock.calls.length === 1) {
        session.proposalRef.current = "registered-operation";
      } else if (mode === "agent-replaces-host") {
        session.proposalRef.current = hash;
        session.proposalRef.operation = operation;
      }
      observedProposal = session.proposalRef.current;
      return { text: "Okay, leaving it as is." };
    });
    const router = createRouterHarness({ runAgentTurn, classifyApproval: classifyText });
    if (mode !== "agent-decline") {
      router.propose(mode === "host-setup" ? operation : portChange);
    }
    if (mode === "host-setup") {
      expect(router.getPendingOperatorProposal()).toEqual(proposal);
      expect(router.getPendingOperatorProposal()).toEqual(proposal);
    }
    await router.resolveTurn(
      mode === "agent-decline" ? "change the model" : "what does workspace mean?",
    );
    if (mode !== "agent-decline") {
      expect(router.getPendingOperatorProposal()).toEqual(proposal);
    }
    if (mode === "host-setup") {
      expectText(runAgentTurn.mock.calls[0]?.[0].input, [
        '"model":"openai/gpt-5.5"',
        "Keep the verified model",
      ]);
    }
    const reply = await router.resolveTurn(mode === "agent-decline" ? "no thanks" : "yes");
    if (mode === "agent-decline") {
      expect(observedProposal).toBeUndefined();
      expect(reply.text).toContain("leaving it as is");
      expect(runAgentTurn).toHaveBeenCalledTimes(2);
    } else if (mode === "agent-replaces-host") {
      const armed = runAgentTurn.mock.calls.map(([params]) => params.approvalArmed);
      expect(armed).toEqual([false, true]);
      expect(runAgentTurn.mock.calls[1]?.[0].input).not.toContain("host-seeded");
    } else {
      expect(runAgentTurn).toHaveBeenCalledOnce();
      expect(router.getPendingOperatorProposal()).toBeNull();
    }
  },
);

it("keeps a host-resolution marker queued across a failed turn", async () => {
  const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text: "native reply" }));
  runAgentTurn.mockResolvedValueOnce(null);
  const router = createRouterHarness({ runAgentTurn, classifyApproval: approveYes });
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

const token = "123:actual-gateway-token";
const webhook = "https://gateway.example/webhook/synology?access_token=very-secret";
it.each([
  ["set", 'channels.synology-chat.accounts["prod.guild"].webhookUrl', webhook],
  ["set", "plugins.entries.codex.config.appServer.headers.Authorization", "Bearer very-secret"],
  ["ref", "gateway.auth.token", token],
  [
    "invalid",
    "config set plugins.entries.codex.config.appServer.headers.Authorization=Bearer-abc please",
    "",
  ],
  ["hidden", "config set plugins.entries.missing.config.opaque.abcDEF123 please", ""],
  [
    "hidden",
    'config set channels.synology-chat.accounts["prod.guild"].webhookUrl.abcDEF123 please',
    "",
  ],
] as const)("keeps %s command %s out of model paths and history", async (kind, path, value) => {
  const writes = kind === "set" || kind === "ref" || kind === "invalid";
  if (kind === "set" || kind === "invalid") {
    useTempStateDir();
  }
  const runConfigSet = vi.fn(async () => {});
  const { engine, runAgentTurn } = commandHarness("still pending", {
    ...(writes ? { deps: { runConfigSet } } : {}),
    ...(kind === "ref" || kind === "hidden"
      ? { classifyApproval: async () => "other" as const }
      : {}),
  });
  const command =
    kind === "set"
      ? `config set ${path} ${value}`
      : kind === "ref"
        ? `config set-ref ${path} exec ${value}`
        : path;
  const proposed = await engine.handle(command);
  expect(runAgentTurn).not.toHaveBeenCalled();
  expectText(proposed.text, [], ["very-secret", "abcDEF123", "actual-gateway-token", "Bearer-abc"]);
  if (kind === "set" || kind === "ref") {
    expect(engine.getPendingOperatorProposal()?.operation).toEqual(
      kind === "set"
        ? { kind: "config-set", path, value }
        : { kind: "config-set-ref", path, source: "exec", id: value },
    );
    if (kind === "set") {
      expect(proposed.text).toContain("<redacted>");
    }
    await engine.handle(kind === "set" ? "what is that setting?" : "what will this change?");
    expectText(
      runAgentTurn.mock.calls.map(([params]) => params.input).join("\n"),
      ["<redacted>"],
      [kind === "set" ? "very-secret" : token],
    );
    if (kind === "set") {
      expect((await engine.handle("yes")).text).toContain("[openclaw] done: config.set");
      expect(runConfigSet).toHaveBeenCalledOnce();
    }
  } else {
    if (kind !== "hidden") {
      expect(proposed.text).toContain("Invalid config path");
    }
    if (kind === "invalid") {
      expect(engine.getPendingOperatorProposal()).toBeNull();
    }
    if (kind === "hidden") {
      await engine.handle("no");
    }
    await engine.handle("did that work?");
  }
  const history = engine.historySince(0);
  expectText(
    JSON.stringify(history),
    [],
    ["very-secret", "abcDEF123", "actual-gateway-token", "Bearer-abc"],
  );
  if (kind === "set") {
    expect(JSON.stringify(history)).toContain("<redacted secret>");
  } else if (kind === "invalid") {
    expect(
      history.some((turn) => turn.role === "user" && turn.text.includes("<redacted secret>")),
    ).toBe(true);
  }
});

it("redacts vulnerable config command text when persisted history is seeded", () => {
  const engine = createEngine();
  engine.seedHistory([
    { role: "user", text: `config set-ref gateway.auth.token exec ${token}` },
    { role: "user", text: "config get gateway.auth.tokenabcDEF123" },
  ]);
  expectText(JSON.stringify(engine.historySince(0)), [], ["actual-gateway-token", "abcDEF123"]);
});
