/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import {
  completeConfigContext,
  mountConfigPage,
  publishConfigSource,
} from "./config-page.test-support.ts";
import type { ConfigPageRouteData } from "./config-page.tsx";
import { configSelectionFromSearch, type ConfigPageId } from "./config-sections.ts";
import { configRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

const objectSchema = (properties: object) => ({ type: "object", properties });
const fieldSchema = (field: string, type: string) => objectSchema({ [field]: { type } });
const communicationsRoute = (search = "", hash = "") =>
  configRouteData({ pathname: "/settings/communications", search, hash });
const catalogModels = (id: string, name: string, provider = "openai") => [{ id, name, provider }];
function gatewaySource(overrides: Partial<ApplicationGatewaySnapshot>) {
  return createApplicationGateway({ ...createApplicationGateway().gateway.snapshot, ...overrides });
}
function query<T extends Element = HTMLElement>(root: ParentNode, selector: string) {
  return expectDefined(root.querySelector<T>(selector), selector);
}
const emptyRequest = () =>
  vi.fn((method: string) => Promise.resolve(method === "models.list" ? { models: [] } : {}));

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConfigPage navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  it("keeps curated sections off the Advanced page", () => {
    for (const [section, activeSection] of [
      ["messages", null],
      ["env", "env"],
      ["mcp", null],
      ["tts", null],
      ["broadcast", "broadcast"],
      ["models", "models"],
    ]) {
      expect(configSelectionFromSearch("advanced", `?section=${section}`)).toEqual({
        activeSection,
        activeSubsection: null,
      });
    }
  });
  it("rejects an unsupported runtime page id", () => {
    expect(() => configSelectionFromSearch("__proto__" as ConfigPageId, "")).toThrow(
      "Unknown config page",
    );
  });

  function routeContext(): ApplicationContext {
    const config = { messages: { ackReaction: "!" }, tts: { provider: "synthetic" } };
    const { gateway } = gatewaySource({
      phase: "offline",
      offlineStable: true,
      assistantAgentId: "main",
      sessionKey: "main",
    });
    return completeConfigContext({
      gateway,
      runtimeConfig: {
        state: {
          connected: false,
          configSnapshot: { config, runtimeConfig: config, hash: "settings-defaults" },
          configSchema: objectSchema({
            messages: fieldSchema("ackReaction", "string"),
            tts: fieldSchema("provider", "string"),
          }),
          configForm: config,
          configFormOriginal: config,
          configRaw: JSON.stringify(config),
          configRawOriginal: JSON.stringify(config),
        },
      },
    } as unknown as ApplicationContext);
  }

  describe("ConfigPage route selections", () => {
    it.each([
      { pageId: "communications", section: "transcripts" },
      { pageId: "ai-agents", section: "session" },
    ] as const)(
      "opens the $section advanced editor for a matching hash",
      async ({ pageId, section }) => {
        const context = routeContext();
        const config = { [section]: { enabled: true } };
        Object.assign(context.runtimeConfig.state, {
          configForm: config,
          configSchema: objectSchema({ [section]: fieldSchema("enabled", "boolean") }),
        });
        const routeData = configRouteData({
          pathname: `/settings/${pageId}`,
          search: `?section=${section}`,
          hash: "",
        });
        const view = mountConfigPage(context, { pageId, routeData });
        const editor = view.container.querySelector(`#config-section-${section}`)!;
        const disclosure = editor.closest("details")!;
        expect(disclosure.open).toBe(false);
        view.update({
          routeData: {
            ...routeData,
            hash: `#config-section-${section}`,
            targetBlockId: `config-section-${section}`,
          },
        });
        await waitForSolid(() => expect(disclosure.open).toBe(true));
        expect(view.container.querySelector(`#config-section-${section}`)).toBe(editor);
      },
    );

    it.each([
      { profile: undefined, writes: 1 },
      { profile: "full", writes: 0 },
    ])("Security Full preserves an explicit choice from $profile", async ({ profile, writes }) => {
      const context = routeContext();
      const patchForm = vi.fn();
      const removeFormValue = vi.fn();
      Object.assign(context.gateway.snapshot, {
        phase: "connected",
        hello: gatewayHelloForMethods(["config.set"]),
      });
      Object.assign(context.runtimeConfig, { canSet: true, patchForm, removeFormValue });
      Object.assign(context.runtimeConfig.state, {
        connected: true,
        configForm: profile ? { tools: { profile } } : {},
      });
      const { page } = mountConfigPage(context, { pageId: "security" });

      expect(patchForm).not.toHaveBeenCalled();
      expect(removeFormValue).not.toHaveBeenCalled();
      const full = query<HTMLInputElement>(page, '.settings-segmented__input[value="full"]');
      expect(page.querySelectorAll(".settings-segmented__input")).toHaveLength(4);
      expect(page.querySelectorAll(".settings-segmented__btn--active")).toHaveLength(
        profile ? 1 : 0,
      );
      full.click();
      expect(patchForm).toHaveBeenCalledTimes(writes);
      if (writes > 0) {
        expect(patchForm).toHaveBeenCalledWith(["tools", "profile"], "full");
      }
      expect(removeFormValue).not.toHaveBeenCalled();
    });

    it.each([
      ["communications", "?section=tts", "config-section-tts", "config-section-messages"],
      ["notifications", "", "settings-communications-notifications", "config-section-messages"],
    ] as const)(
      "renders the selected section for %s%s",
      async (pageId, search, visibleId, absentId) => {
        const route = expectDefined(
          pages.find((entry) => entry.id === pageId),
          "config route",
        );
        const context = routeContext();
        const location = { pathname: `/settings/${pageId}`, search, hash: "" };
        const data = await route.loader?.(context, {
          location,
          signal: new AbortController().signal,
          shouldRun: () => true,
          revalidating: false,
          deps: expectDefined(route.loaderDeps, "config route dependencies")(context, location),
          cause: "navigation",
        });
        if (!data || typeof data !== "object" || !("section" in data)) {
          throw new Error("Config route did not return section data");
        }
        expect(data).toMatchObject({ pageId });
        const module = await route.component();
        const provider = createSolidApplicationContextProvider(completeConfigContext(context));
        const render = expectDefined(module.renderSolid, "Solid config route");
        const { container } = mountSolid(
          () =>
            render({ data: data as ConfigPageRouteData, loaderPending: false, presented: true }),
          { wrapper: provider.wrapper },
        );
        const page = query(container, "openclaw-config-page");
        flush();

        await waitForSolid(() => expect(page.querySelector(`#${visibleId}`)).not.toBeNull());
        expect(page.querySelector(`#${absentId}`)).toBeNull();
        if (pageId === "communications") {
          expect(page.querySelector('.hub-tab[aria-selected="true"]')?.textContent?.trim()).toBe(
            search ? "Voice" : "Messages",
          );
        }
      },
    );
  });

  it("keeps the config owner through a pending subpage loader in the real outlet", async () => {
    const context = completeConfigContext(routeContext());
    const configPages = pages.filter((route) => route.id !== "settings" && route.id !== "config");
    const findRoute = (id: string) =>
      expectDefined(
        configPages.find((route) => route.id === id),
        id,
      );
    const communications = findRoute("communications");
    const advanced = findRoute("advanced");
    const loadAdvanced = expectDefined(advanced.loader, "advanced loader");
    const releaseAdvanced = deferred();
    const provider = createSolidApplicationContextProvider(context);
    const productionModule = await communications.component();
    const render = productionModule.renderSolid;
    expect((await advanced.component()).renderSolid).toBe(render);
    const module = {
      ...productionModule,
      renderSolid: (props: Parameters<typeof render>[0]) =>
        createComponent(provider.wrapper, {
          get children() {
            return createComponent(render, props);
          },
        }),
    };
    const router = createRouter<
      ConfigPageId,
      ApplicationContext,
      typeof module,
      ConfigPageRouteData
    >({
      routes: [
        { ...communications, component: () => module },
        {
          ...advanced,
          component: () => module,
          loader: async (...args: Parameters<typeof loadAdvanced>) => {
            const data = loadAdvanced(...args);
            await releaseAdvanced.promise;
            return data;
          },
        },
      ],
    });
    const mounted = mountRouterOutlet({ router, retryContext: context });
    try {
      await router.navigate(
        "communications",
        context,
        {},
        { pathname: "/settings/communications", search: "?section=tts", hash: "" },
      );
      await waitForSolid(() => {
        expect(mounted.querySelector("#config-section-tts")).not.toBeNull();
      });
      const host = query(mounted, "openclaw-config-page");
      const title = () => host.querySelector(".content-header--settings .page-title")?.textContent;
      expect(title()).toBe("Communications");

      const navigation = router.navigate("advanced", context);
      await waitForSolid(() => {
        const pending = router.getState().matches[0];
        expect(pending).toMatchObject({ routeId: "advanced", status: "pending" });
        expect(pending?.module).toBeDefined();
        expect(pending?.data).toBeUndefined();
      });
      expect(mounted.querySelector("openclaw-config-page")).toBe(host);
      expect(host.isConnected).toBe(true);
      expect(title()).toBe("Communications");
      expect(host.querySelector("#config-section-tts")).not.toBeNull();

      releaseAdvanced.resolve(undefined);
      await navigation;
      await waitForSolid(() => expect(title()).toBe("Advanced"));
      expect(mounted.querySelector("openclaw-config-page")).toBe(host);
      expect(host.isConnected).toBe(true);
    } finally {
      releaseAdvanced.resolve(undefined);
      mounted.dispose();
      router.stop();
    }
  });

  it.each(["replacement", "retirement", "disconnect"] as const)(
    "does not scroll to a stale target after %s",
    async (transition) => {
      const view = mountConfigPage(routeContext(), {
        pageId: "communications",
        routeData: communicationsRoute(),
      });
      const { page } = view;
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrameId = 0;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        const id = ++nextFrameId;
        frames.set(id, callback);
        return id;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
      const previousTarget = query(page, "#config-section-messages");
      const previousScroll = vi.fn();
      previousTarget.scrollIntoView = previousScroll;
      view.update({
        routeData: communicationsRoute("", "#config-section-messages"),
      });
      expect(previousScroll).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);

      if (transition === "disconnect") {
        view.dispose();
      } else {
        view.update({
          routeData:
            transition === "replacement"
              ? communicationsRoute("?section=tts", "#config-section-tts")
              : communicationsRoute(),
        });
      }
      const nextScroll = vi.fn();
      if (transition === "replacement") {
        query(page, "#config-section-tts").scrollIntoView = nextScroll;
        expect(frames.size).toBe(1);
      } else {
        expect(frames.size).toBe(0);
      }
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) {
        frame(0);
      }
      expect(previousScroll).not.toHaveBeenCalled();
      expect(nextScroll).toHaveBeenCalledTimes(transition === "replacement" ? 1 : 0);
    },
  );
});

describe("ConfigPage model catalog lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.useFakeTimers();
  });

  async function mount(
    client: GatewayBrowserClient,
    scopes: readonly string[] = ["operator.admin"],
  ) {
    const source = gatewaySource({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(["system.info"], scopes),
    });
    const context = {
      gateway: source.gateway,
      runtimeConfig: { state: { configSnapshot: {}, configSchema: {} } },
    } as unknown as ApplicationContext;
    const view = mountConfigPage(context, { pageId: "appearance" });
    await waitForSolid(() =>
      expect(
        view.page.querySelector("#settings-appearance-sidebar openclaw-select-picker"),
      ).not.toBeNull(),
    );
    return { view, source, context };
  }

  function observerModels(view: ReturnType<typeof mountConfigPage>) {
    const picker = query<
      HTMLElement & {
        params: { options: Array<{ value: string; label: string }> };
      }
    >(view.page, "#settings-appearance-sidebar openclaw-select-picker");
    return picker.params.options.slice(2).map(({ value, label }) => ({ value, label }));
  }

  function expectModels(
    view: ReturnType<typeof mountConfigPage>,
    models: ModelCatalogEntry[] = [],
  ) {
    const expected = models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name,
    }));
    return waitForSolid(() => expect(observerModels(view)).toEqual(expected));
  }

  function statusReads(request: { mock: { calls: Array<[string, ...unknown[]]> } }) {
    return request.mock.calls.filter(([method]) => method === "system.info");
  }

  it("keeps session-only Appearance usable without polling host details or models", async () => {
    const request = vi.fn().mockResolvedValue({});
    const { view, source } = await mount({ request } as unknown as GatewayBrowserClient, [
      "operator.sessions.read",
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).not.toHaveBeenCalled();
    await expectModels(view);
    source.publish({
      ...source.gateway.snapshot,
      hello: gatewayHelloForMethods(["system.info"]),
    });
    flush();
    await waitForSolid(() => expect(statusReads(request)).toHaveLength(1));
    source.publish({
      ...source.gateway.snapshot,
      hello: gatewayHelloForMethods(["system.info"], ["operator.sessions.read"]),
    });
    flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForSolid(() => expect(statusReads(request)).toHaveLength(1));
    await expectModels(view);
  });

  it("pauses hidden status reads and resumes one ten-second poll when visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const request = emptyRequest();
    const { view } = await mount({ request } as unknown as GatewayBrowserClient);
    const reads = () => statusReads(request);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toHaveLength(0);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    flush();
    expect(reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toHaveLength(2);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toHaveLength(2);
    view.dispose();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads()).toHaveLength(2);
  });

  it.each(["client", "source"] as const)(
    "fences a pending catalog after Gateway %s replacement",
    async (replacement) => {
      const first = deferred<ModelCatalogResult>();
      const second = deferred<ModelCatalogResult>();
      vi.spyOn(modelCatalogStore, "loadModelCatalog")
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const firstClient = {
        request: vi.fn().mockResolvedValue({}),
      } as unknown as GatewayBrowserClient;
      const secondClient =
        replacement === "client"
          ? ({ request: vi.fn().mockResolvedValue({}) } as unknown as GatewayBrowserClient)
          : firstClient;
      const { view, source, context } = await mount(firstClient);
      await waitForSolid(() => expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledOnce());
      const snapshot = { ...source.gateway.snapshot, client: secondClient };
      if (replacement === "source") {
        view.setContext({ ...context, gateway: createApplicationGateway(snapshot).gateway });
      } else {
        source.publish(snapshot);
      }
      flush();
      const currentModels = catalogModels("small", "Small");
      second.resolve({ models: currentModels });
      flush();
      await expectModels(view, currentModels);

      first.resolve({ models: catalogModels("stale", "Stale", "old") });
      await first.promise;
      flush();
      await expectModels(view, currentModels);
      expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
      for (const [index, client] of [firstClient, secondClient].entries()) {
        expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(index + 1, client, {
          agentId: "main",
          preparedOnly: true,
          signal: expect.any(AbortSignal),
        });
      }
    },
  );

  it("keeps same-client agent switches from restoring stale observer models", async () => {
    const firstMain = deferred<ModelCatalogResult>();
    const writer = deferred<ModelCatalogResult>();
    const secondMain = deferred<ModelCatalogResult>();
    let mainRequests = 0;
    const request = vi.fn((method: string, params: unknown) => {
      if (method === "system.info") {
        return Promise.resolve({});
      }
      const agentId = (params as { agentId?: string }).agentId;
      if (agentId === "writer") {
        return writer.promise;
      }
      mainRequests += 1;
      return mainRequests === 1 ? firstMain.promise : secondMain.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { view, context } = await mount(client);
    await waitForSolid(() => expect(mainRequests).toBe(1));
    const selection = context.settingsAgentSelection.state as { selectedId: string | null };
    selection.selectedId = "writer";
    publishConfigSource(context.settingsAgentSelection);
    const writerModels = catalogModels("writer-model", "Writer Model");
    writer.resolve({ models: writerModels });
    flush();
    await expectModels(view, writerModels);

    selection.selectedId = "main";
    publishConfigSource(context.settingsAgentSelection);
    const currentMainModels = catalogModels("current-main", "Current Main");
    await waitForSolid(() => expect(mainRequests).toBe(2));
    await expectModels(view);
    firstMain.resolve({ models: catalogModels("stale-main", "Stale Main") });
    flush();
    expect(mainRequests).toBe(2);
    await expectModels(view);
    secondMain.resolve({ models: currentMainModels });
    flush();
    await expectModels(view, currentMainModels);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual(
      ["main", "writer", "main"].map((agentId) => [
        "models.list",
        { agentId, preparedOnly: true, view: "configured" },
      ]),
    );

    selection.selectedId = null;
    publishConfigSource(context.settingsAgentSelection);
    await expectModels(view);
    await waitForSolid(() =>
      expect(view.page.textContent).toContain("Explicit model catalog unavailable"),
    );
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(3);
  });

  it("keeps a slow refresh through status polls and retires its page reader on detach", async () => {
    const stale = deferred<ModelCatalogResult>();
    const original = catalogModels("original", "Original");
    const fresh = catalogModels("fresh", "Fresh");
    let catalogReads = 0;
    const request = vi.fn((method: string) => {
      if (method === "system.info") {
        return Promise.resolve({});
      }
      catalogReads += 1;
      if (catalogReads !== 2) {
        return Promise.resolve({ models: catalogReads === 1 ? original : fresh });
      }
      return stale.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { view, context } = await mount(client);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(catalogReads).toBe(1);

    // The application retires catalogs on publication; the next status poll reads that generation.
    invalidateChatMetadataStore(client);
    await vi.advanceTimersByTimeAsync(10_000);
    await expectModels(view, original);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statusReads(request)).toHaveLength(6);
    expect(catalogReads).toBe(2);
    view.dispose();
    flush();

    const remounted = mountConfigPage(context, { pageId: "appearance" });
    await waitForSolid(() => expect(catalogReads).toBe(3));
    await expectModels(remounted, fresh);
    stale.resolve({ models: original });
    flush();
    await expectModels(remounted, fresh);
    expect(catalogReads).toBe(3);
  });

  it("stops status polling outside Appearance while the page remains mounted", async () => {
    const request = emptyRequest();
    const { view } = await mount({ request } as unknown as GatewayBrowserClient);
    await waitForSolid(() => expect(statusReads(request)).toHaveLength(1));
    view.update({ pageId: "advanced" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(view.page.isConnected).toBe(true);
    await waitForSolid(() => expect(statusReads(request)).toHaveLength(1));
    view.update({ pageId: "appearance" });
    await waitForSolid(() => expect(statusReads(request)).toHaveLength(2));
  });
});

describe("ConfigPage meeting capture", () => {
  it("keeps Messages default and opens capture with a collapsed schema editor inside the section panel", async () => {
    const config = { messages: { ackReaction: "ok" }, transcripts: { enabled: true } };
    const request = vi.fn(async (method: string) => {
      if (method === "transcripts.status") {
        return meetingStatus;
      }
      if (method === "config.schema") {
        return {
          schema: objectSchema({
            messages: fieldSchema("ackReaction", "string"),
            tts: fieldSchema("enabled", "boolean"),
            transcripts: fieldSchema("enabled", "boolean"),
          }),
          uiHints: {},
        };
      }
      return {
        config,
        hash: "one",
        appliedConfigHash: "one",
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      };
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    try {
      await runtimeConfig.ensureLoaded();
      await runtimeConfig.ensureSchemaLoaded();
      const context = {
        gateway: { ...gateway, connection: { gatewayUrl: "ws://transcripts.test" } },
        runtimeConfig,
        navigate: vi.fn(),
        overlays: { snapshot: { updateRunning: false, updateReconciliationPending: false } },
      } as unknown as ApplicationContext;
      const view = mountConfigPage(context, { pageId: "communications" });
      const { container } = view;
      const captureSettings = () => container.querySelector("openclaw-meeting-capture-settings");
      const tab = (name: string) => query(container, `.hub-tab[data-tab-value="${name}"]`);
      const enter = (element: HTMLElement) =>
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(captureSettings()).toBeNull();
      const captureTab = tab("transcripts");
      expect(captureTab.textContent?.trim()).toBe("Meeting capture");
      const tabs = captureTab.closest(".hub-tabs")!;
      expect(tabs.querySelector("[active]")?.getAttribute("data-tab-value")).toBe("messages");
      enter(captureTab);
      flush();
      const capture = query(container, "openclaw-meeting-capture-settings");
      expect(container.querySelector("#config-section-panel")?.contains(capture)).toBe(true);
      flush();
      const advanced = query<HTMLDetailsElement>(capture, "details");
      expect(advanced.open).toBe(false);
      expect(advanced.querySelector("#config-section-transcripts")).not.toBeNull();
      const toggle = query<HTMLInputElement>(capture, ".settings-toggle__input");
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      expect(runtimeConfig.state.configForm).toMatchObject({ transcripts: { enabled: false } });
      expect(
        [...capture.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Save",
        ),
      ).toBe(false);
      const advancedToggled = new Promise<void>((resolve) => {
        advanced.addEventListener("toggle", () => resolve(), { once: true });
      });
      view.update({
        routeData: communicationsRoute(
          "?section=transcripts&advanced=1",
          "#config-section-transcripts",
        ),
      });
      await waitForSolid(() => expect(advanced.open).toBe(true));
      expect(captureSettings()).toBe(capture);
      expect(capture.querySelector("details")).toBe(advanced);
      await advancedToggled;
      const messagesTab = tab("messages");
      messagesTab.focus();
      enter(messagesTab);
      flush();
      expect(captureSettings()).toBeNull();
      flush();
      expect(document.activeElement).toBe(messagesTab);
    } finally {
      cleanupSolid();
      runtimeConfig.dispose();
    }
  });
});
