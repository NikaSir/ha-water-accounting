import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const bundlePath = new URL(
  "../custom_components/water_accounting/frontend/water-accounting-panel.js",
  import.meta.url,
);
const source = fs.readFileSync(bundlePath, "utf8");

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  toggle(name, enabled) {
    if (enabled) this.names.add(name);
    else this.names.delete(name);
  }
  contains(name) { return this.names.has(name); }
}

class FakeIcon {
  constructor() { this.attributes = new Map([["icon", "mdi:refresh"]]); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

class FakeButton {
  constructor() {
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.disabled = false;
    this.icon = new FakeIcon();
    this.style = {};
  }
  querySelector(selector) { return selector === "ha-icon" ? this.icon : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

class FakeToast {
  constructor() {
    this.textContent = "";
    this.classList = new FakeClassList();
  }
}

class FakeShadowRoot {
  constructor() {
    this.refresh = new FakeButton();
    this.toast = new FakeToast();
  }
  querySelector(selector) {
    if (selector === "#refresh") return this.refresh;
    if (selector === ".panel-toast") return this.toast;
    return null;
  }
}

globalThis.HTMLElement = class {
  constructor() { this.isConnected = true; }
  attachShadow() {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }
  addEventListener() {}
  removeEventListener() {}
};
const registry = new Map();
globalThis.customElements = {
  define(name, constructor) { registry.set(name, constructor); },
  get(name) { return registry.get(name); },
};
globalThis.Event = class Event {};
globalThis.CustomEvent = class CustomEvent {};
globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.document = { documentElement: {}, children: [] };
globalThis.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
};
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  disconnect() {}
};

let now = 0;
let nextTimerId = 1;
const timers = new Map();
globalThis.performance = { now: () => now };
globalThis.window = {
  setTimeout(callback, delay) {
    const id = nextTimerId++;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
};

function runDelay(delay) {
  const match = [...timers.entries()].find(([, timer]) => Math.abs(timer.delay - delay) < 0.01);
  assert.ok(match, `expected a ${delay} ms timer`);
  const [id, timer] = match;
  timers.delete(id);
  now += timer.delay;
  timer.callback();
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

vm.runInThisContext(source, { filename: bundlePath.pathname });
const Panel = customElements.get("nikas-water-accounting-panel");
assert.ok(Panel, "production bundle must register nikas-water-accounting-panel");

function makePanel(callService, loadResult = { status: "complete" }) {
  const panel = new Panel();
  panel._hass = callService ? { callService } : {};
  panel._loadPeriod = async () => loadResult;
  panel._queuePatch = () => {};
  return panel;
}

{
  const calls = [];
  const panel = makePanel(async (...args) => { calls.push(args); });
  const pending = panel._refresh();
  const duplicate = await panel._refresh();
  assert.equal(duplicate, false, "busy refresh must reject duplicate activation");
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(panel.shadowRoot.refresh.disabled, true);
  assert.equal(panel.shadowRoot.refresh.getAttribute("aria-busy"), "true");
  runDelay(900);
  await flush();
  assert.equal(await pending, true);
  assert.equal(panel.shadowRoot.refresh.icon.getAttribute("icon"), "mdi:check");
  assert.equal(panel.shadowRoot.refresh.getAttribute("aria-label"), "Данные обновлены");
  assert.equal(panel.shadowRoot.refresh.style.color, "#43a047");
  assert.ok([...timers.values()].some((timer) => timer.delay === 1400));
  panel.disconnectedCallback();
}

{
  now = 0;
  timers.clear();
  let resolveService;
  const panel = makePanel(() => new Promise((resolve) => { resolveService = resolve; }));
  const refreshButton = panel.shadowRoot.refresh;
  const pending = panel._refresh();
  await flush();
  assert.equal(refreshButton.disabled, true, "slow request must remain busy");
  now = 1200;
  resolveService();
  await flush();
  assert.equal(await pending, true);
  assert.equal(panel.shadowRoot.refresh, refreshButton, "refresh must patch the mounted button");
  assert.ok(![...timers.values()].some((timer) => timer.delay === 900), "slow success must not add a new minimum delay");
  panel.disconnectedCallback();
}

{
  now = 0;
  timers.clear();
  const panel = makePanel(null);
  const pending = panel._refresh();
  await flush();
  runDelay(900);
  await flush();
  assert.equal(await pending, false, "missing Home Assistant service must fail closed");
  assert.equal(panel.shadowRoot.refresh.icon.getAttribute("icon"), "mdi:alert-circle-outline");
  panel.disconnectedCallback();
}

{
  now = 0;
  timers.clear();
  let rejectService;
  const panel = makePanel(() => new Promise((_resolve, reject) => { rejectService = reject; }));
  const pending = panel._refresh();
  await flush();
  rejectService(new Error("offline"));
  await flush();
  runDelay(900);
  await flush();
  assert.equal(await pending, false);
  assert.equal(panel.shadowRoot.refresh.icon.getAttribute("icon"), "mdi:alert-circle-outline");
  assert.equal(panel.shadowRoot.refresh.getAttribute("aria-label"), "Ошибка обновления");
  assert.equal(panel.shadowRoot.refresh.style.color, "#e53935");
  assert.equal(panel.shadowRoot.toast.textContent, "Обновить данные не удалось");
  panel.disconnectedCallback();
}

{
  now = 0;
  timers.clear();
  const panel = makePanel(async () => {}, { status: "error" });
  const pending = panel._refresh();
  await flush();
  runDelay(900);
  await flush();
  assert.equal(await pending, false, "Recorder partial failure must not show success");
  panel.disconnectedCallback();
}

{
  now = 0;
  timers.clear();
  let calls = 0;
  const panel = makePanel(async () => { calls += 1; });
  panel._view = "meters";
  panel._period = "7d";
  panel._returnRoute = "/dashboard-rooms-v11/rooms";
  const originalContext = [panel._view, panel._period, panel._returnRoute];
  let pending = panel._refresh();
  await flush();
  runDelay(900);
  await flush();
  assert.equal(await pending, true);
  const firstResultTimerIds = [...timers.keys()];
  pending = panel._refresh();
  assert.ok(firstResultTimerIds.every((id) => !timers.has(id)), "retry must cancel prior result timer");
  await flush();
  runDelay(900);
  await flush();
  assert.equal(await pending, true);
  assert.equal(calls, 2);
  assert.deepEqual(
    [panel._view, panel._period, panel._returnRoute],
    originalContext,
    "refresh must preserve view, period and return route",
  );
  runDelay(1400);
  assert.equal(panel.shadowRoot.refresh.icon.getAttribute("icon"), "mdi:refresh");
  panel.disconnectedCallback();
}

{
  now = 0;
  timers.clear();
  const panel = makePanel(async () => {});
  const pending = panel._refresh();
  await flush();
  assert.ok(timers.size > 0);
  panel.disconnectedCallback();
  await flush();
  assert.equal(await pending, true);
  assert.equal(timers.size, 0, "disconnect must clear refresh timers");
}

process.stdout.write("Water UI 0.1.5 / NikaS UI 2.2 production regression OK.\n");
