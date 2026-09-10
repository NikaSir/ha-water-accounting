import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const frontend = "custom_components/water_accounting/frontend";
const [shell, core, zoom, css, bundle] = await Promise.all([
  readFile("templates/shell_v2/nikas-specialized-shell.js", "utf8"),
  readFile(`${frontend}/src/water-accounting-panel-core.js`, "utf8"),
  readFile(`${frontend}/src/zoom-controller.js`, "utf8"),
  readFile(`${frontend}/src/styles.css`, "utf8"),
  readFile(`${frontend}/water-accounting-panel.js`, "utf8"),
]);

assert.equal(
  (core.match(/shadowRoot\.innerHTML\s*=/g) || []).length,
  1,
  "the persistent shell must be mounted exactly once",
);
assert.equal(
  (core.match(/'<main class="canvas-viewport/g) || []).length,
  1,
  "the panel must own exactly one work viewport",
);
assert.match(core, /this\._views = new Map\(\)/, "visited tabs must be cached");
assert.match(core, /new WaterTaskPool\(2\)/, "statistics concurrency must be two");
assert.match(core, /60_000/, "Recorder requests need a 60-second terminal timeout");
assert.match(core, /recorder\/statistics_during_period/, "Recorder statistics API is missing");
assert.match(core, /normalMin: 2\.4, normalMax: 3\.1/, "approved drinking-water range is missing");
assert.match(core, /2,4–3,1/, "approved drinking-water range must be visible on the form");
assert.match(core, /Пороговые значения/, "threshold block must be visible on the form");
assert.match(core, /0,3–&lt;2,5/, "irrigation lower boundary must be explicit");
assert.match(core, /&gt;3,5–4,0/, "irrigation upper boundary must be explicit");
assert.ok(!core.includes("history.back("), "history.back() is forbidden");
assert.ok(!bundle.includes("__WATER_ACCOUNTING_CSS__"), "bundle contains an unresolved CSS marker");
assert.ok(!/^\s*(?:import|export)\b/m.test(bundle), "production bundle has a runtime import/export");
assert.ok(!/\bimport\s*\(/.test(bundle), "production bundle has a dynamic runtime import");
assert.ok(!/^:host\s*\{[^}]*position:\s*fixed/m.test(css), "host must remain bound to ha-panel");
assert.match(shell, /grid-template-rows:calc\(60px \+ env\(safe-area-inset-top,0px\)\) minmax\(0,1fr\)/, "shell must have canonical persistent rows");
assert.match(shell, /calc\(64px \+ env\(safe-area-inset-bottom,0px\)\)/, "bottom bar must be 64px plus safe area");
assert.match(shell, /max-inline-size:1280px/, "canonical work-content frame is missing");
assert.match(shell, /--mdc-icon-size:26px/, "bottom navigation icons must be 26px");
assert.match(core, /createNikasShellScrollBoundaryGuard/, "capture-phase scroll boundary guard is not mounted");
assert.match(css, /\.canvas-viewport\.zoomed\s*\{[\s\S]*overflow: hidden;/, "zoomed viewport must not leak scroll");
assert.ok(!bundle.includes("100dvh"), "100dvh must not create a competing outer viewport");

for (const match of css.matchAll(/font-size:\s*(\d+)px/g)) {
  const size = Number(match[1]);
  assert.ok(size >= 12 && size <= 25, `meaningful typography outside 12–25 px: ${match[0]}`);
}

class HTMLElementMock {
  attachShadow() {
    this.shadowRoot = {};
    return this.shadowRoot;
  }
}

const local = new Map();
const session = new Map();
const context = {
  HTMLElement: HTMLElementMock,
  customElements: { get: () => true, define: () => {} },
  localStorage: {
    getItem: (key) => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, value),
  },
  sessionStorage: {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, value),
    removeItem: (key) => session.delete(key),
  },
  window: {
    location: {
      href: "https://ha.local/dashboard-water",
      origin: "https://ha.local",
      pathname: "/dashboard-water",
      search: "",
      hash: "",
    },
    history: { pushState: () => {} },
    dispatchEvent: () => {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
  },
  document: { referrer: "" },
  URL,
  URLSearchParams,
  Event,
  Intl,
  Promise,
  Date,
  Set,
  Map,
  Number,
  String,
  Object,
  Math,
  JSON,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  console,
};
context.window.window = context.window;
context.window.localStorage = context.localStorage;
context.window.sessionStorage = context.sessionStorage;
vm.createContext(context);
vm.runInContext(
  `${shell}\n${core}\nthis.TestPanel = NikaSWaterAccountingPanel; this.TestPool = WaterTaskPool; this.testResolveReturnRoute = resolveReturnRoute;`,
  context,
);

const panel = new context.TestPanel();
const drinkingId = "sensor.nikas_h2000_pro_pitevaia_voda";
const irrigationId = "sensor.nikas_h2000_pro_voda_na_poliv_2";
panel._hass = { locale: { language: "ru" }, states: {} };

function pressure(kind, value) {
  const entityId = kind === "drinking" ? drinkingId : irrigationId;
  panel._hass.states[entityId] = {
    state: String(value),
    attributes: { unit_of_measurement: "bar" },
  };
  return panel._pressureEvaluation(kind);
}

assert.deepEqual(
  [pressure("drinking", 0).tone, pressure("drinking", 0).label],
  ["bad", "Нет давления"],
);
assert.equal(pressure("drinking", 2.39).tone, "warn");
assert.equal(pressure("drinking", 2.4).tone, "ok");
assert.equal(pressure("drinking", 3.1).tone, "ok");
assert.equal(pressure("drinking", 3.11).tone, "warn");
panel._hass.states[drinkingId] = { state: "unavailable", attributes: {} };
assert.equal(panel._pressureEvaluation("drinking").tone, "unknown");

assert.deepEqual(
  [pressure("irrigation", 0).tone, pressure("irrigation", 0).label],
  ["bad", "Нет давления"],
);
assert.equal(pressure("irrigation", 0.29).tone, "bad");
assert.equal(pressure("irrigation", 0.3).tone, "warn");
assert.equal(pressure("irrigation", 2.49).tone, "warn");
assert.equal(pressure("irrigation", 2.5).tone, "ok");
assert.equal(pressure("irrigation", 3.5).tone, "ok");
assert.equal(pressure("irrigation", 3.51).tone, "warn");
assert.equal(pressure("irrigation", 4).tone, "warn");
assert.equal(pressure("irrigation", 4.01).tone, "bad");

const drinkingTotal = "sensor.schetchik_vody_svd_20_0020989_pokazaniia";
const irrigationTotal = "sensor.schetchik_vody_svd_20_0020988_pokazaniia";
const normalized = panel._normalizeStatistics({
  [drinkingTotal]: [
    { start: 0, sum: 12 },
    { start: 3_600_000, change: 0.12, sum: 12.12 },
    { start: 7_200_000, change: 0.08, sum: 12.20 },
  ],
  [irrigationTotal]: [
    { start: 0, sum: 4 },
    { start: 3_600_000, change: 0.50, sum: 4.50 },
    { start: 7_200_000, change: 0, sum: 4.50 },
  ],
}, { key: "24h", period: "hour", start: new Date(3_600_000), end: new Date(10_800_000) });
assert.equal(normalized.drinking, 0.20);
assert.equal(normalized.irrigation, 0.50);
assert.equal(normalized.total, 0.70);
assert.equal(normalized.buckets.length, 2);

function setLocation(href) {
  const parsed = new URL(href);
  context.window.location = {
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

setLocation("https://ha.local/dashboard-water?return_to=https%3A%2F%2Fevil.example%2Fdashboard-house&from=%2Fdashboard-actions%2Fwhatever");
session.clear();
assert.equal(
  context.testResolveReturnRoute({ _panel: null }),
  "/dashboard-actions/home",
  "invalid return_to must not suppress a valid from route",
);
setLocation("https://ha.local/dashboard-water?from=%2Fdashboard-house-v13%2Fdetails");
session.clear();
assert.equal(
  context.testResolveReturnRoute({ _panel: null }),
  "/dashboard-house-v13/home",
  "current House source route must be canonicalized",
);

setLocation("https://ha.local/dashboard-water");
session.clear();
session.set("nikas.specialized.source_route.v1", "/dashboard-infrastructure/water");
session.set("nikas.specialized.source_route_at.v1", String(Date.now()));
assert.equal(
  context.testResolveReturnRoute({ _panel: null }),
  "/dashboard-infrastructure/overview",
  "fresh source hand-off must be canonicalized",
);

setLocation("https://ha.local/dashboard-water?from=%2Fdashboard-rooms-v11%2Fdetails");
session.clear();
assert.equal(
  context.testResolveReturnRoute({ _panel: null }),
  "/dashboard-rooms-v11/rooms",
  "Rooms source route must be canonicalized",
);

const pool = new context.TestPool(2);
let active = 0;
let maximum = 0;
await Promise.all(Array.from({ length: 6 }, (_value, index) => pool.run(() => new Promise((resolve) => {
  active += 1;
  maximum = Math.max(maximum, active);
  setTimeout(() => {
    active -= 1;
    resolve(index);
  }, 5);
}))));
assert.equal(maximum, 2, "statistics task pool exceeded its concurrency limit");

process.stdout.write("Panel contract and runtime checks passed.\n");
