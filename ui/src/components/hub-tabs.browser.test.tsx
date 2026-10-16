import { html, nothing, render } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderHubTabs } from "./hub-tabs.ts";
import { HubTabs } from "./solid/hub-tabs.tsx";
import "../styles/base.css";

it.each(["primary", "sub"] as const)(
  "keeps %s hub tabs at their natural height above a flexing panel",
  async (variant) => {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;width:240px";
    document.body.append(root);
    onTestFinished(() => {
      render(nothing, root);
      root.remove();
    });
    render(
      html`${renderHubTabs({
          id: "bounded",
          active: "sessions",
          tabs: [
            { value: "sessions", label: "Sessions" },
            { value: "live", label: "Live activity" },
          ],
          ariaLabel: "Activity view",
          panelId: "bounded-panel",
          variant,
          onSelect: vi.fn(),
        })}
        <div id="bounded-panel" style="flex:1 1 auto;min-height:0">
          <div style="height:600px">Activity content</div>
        </div>`,
      root,
    );
    await Promise.resolve();
    const tabs = root.querySelector<HTMLElement>("[role=tablist]")!;
    const naturalHeight = tabs.getBoundingClientRect().height;
    expect(naturalHeight).toBeGreaterThan(24);

    root.style.height = "180px";
    expect(tabs.getBoundingClientRect().height).toBe(naturalHeight);
    expect(
      root.querySelector("#bounded-panel")!.getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(root.getBoundingClientRect().bottom);
  },
);

it("restores keyboard focus when navigation replaces a Solid tab strip with Lit", async () => {
  const root = document.createElement("div");
  const destination = document.createElement("div");
  document.body.append(root);
  onTestFinished(() => {
    render(nothing, destination);
    root.remove();
  });
  const onSelect = vi.fn();
  const tabs: Array<{ value: "plugins" | "skills"; label: string }> = [
    { value: "plugins", label: "Plugins" },
    { value: "skills", label: "Skills" },
  ];
  const source = mountSolid(
    () => (
      <HubTabs
        id="mixed"
        active="plugins"
        tabs={tabs}
        ariaLabel="Sections"
        panelId="mixed-panel"
        onSelect={onSelect}
      />
    ),
    { baseElement: root },
  );
  await waitForSolid(() => expect(root.querySelector("#mixed-tab-skills")).not.toBeNull());
  const target = root.querySelector<HTMLElement>("#mixed-tab-skills")!;
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSelect).toHaveBeenCalledWith("skills");

  source.unmount();
  root.append(destination);
  render(
    renderHubTabs({
      id: "mixed",
      active: "skills",
      tabs,
      ariaLabel: "Sections",
      panelId: "mixed-panel",
      onSelect,
    }),
    destination,
  );
  await expect.poll(() => document.activeElement?.id).toBe("mixed-tab-skills");
});
