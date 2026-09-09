import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Most fixtures use UTC; the daylight-saving case explicitly changes it back.
process.env.TZ = "UTC";

// Exercise the shipped custom element, not a copied implementation of its math.
const bundle = await readFile(
  new URL("../custom_components/water_accounting/frontend/water-accounting-panel.js", import.meta.url),
  "utf8",
);
const HOUR = 3_600_000;
const START = Date.parse("2026-01-15T00:00:00Z");
const NOW = Date.parse("2026-09-08T12:34:56Z");
const DRINKING = "sensor.test_drinking";
const IRRIGATION = "sensor.test_irrigation";

class NodeMock {
  constructor() {
    this.nodes = new Map();
    this.dataset = {};
    this.textContent = "";
    this.innerHTML = "";
  }

  querySelector(selector) { return this.nodes.get(selector) ?? null; }
  querySelectorAll(selector) { return this.nodes.has(selector) ? [this.nodes.get(selector)] : []; }
  add(selector, node = new NodeMock()) { this.nodes.set(selector, node); return node; }
}

class HTMLElementMock {
  attachShadow() { this.shadowRoot = new NodeMock(); return this.shadowRoot; }
}

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

const registered = new Map();
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
const context = {
  HTMLElement: HTMLElementMock,
  customElements: {
    get: (name) => registered.get(name),
    define: (name, constructor) => registered.set(name, constructor),
  },
  MutationObserver: class { observe() {} disconnect() {} },
  Node: { ELEMENT_NODE: 1 },
  localStorage: storage,
  sessionStorage: storage,
  document: { referrer: "", documentElement: {}, children: [] },
  window: {
    location: { href: "https://ha.local/dashboard-water", origin: "https://ha.local" },
    localStorage: storage,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
  },
  Date: FixedDate,
  URL,
  Intl,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  console,
};
vm.runInNewContext(bundle, context, { filename: "water-accounting-panel.js" });
const Panel = registered.get("nikas-water-accounting-panel");
assert.equal(typeof Panel, "function", "production bundle must register its custom element");

function makePanel() {
  const panel = new Panel();
  panel._panel = { config: { entities: { drinking_total: DRINKING, irrigation_total: IRRIGATION } } };
  panel._hass = { locale: { language: "ru" }, states: {} };
  return panel;
}

function definition(hours = 4, period = "hour", start = START) {
  return { key: "24h", start: new Date(start), end: new Date(start + hours * HOUR), period };
}

function series(values, start = START, baseline = 100) {
  let sum = baseline;
  return [{ start: start - HOUR, sum, change: null }, ...values.map((change, index) => {
    if (Number.isFinite(change)) sum += change;
    return { start: start + index * HOUR, change, sum };
  })];
}

function raw(drinking, irrigation) {
  return { [DRINKING]: drinking, [IRRIGATION]: irrigation };
}

function normalize(drinking, irrigation, period = definition()) {
  return makePanel()._normalizeStatistics(raw(drinking, irrigation), period);
}

function assertCoverage(result, expected, drinking, irrigation) {
  assert.equal(result.coverage.expected, expected);
  assert.equal(result.coverage.drinking, drinking);
  assert.equal(result.coverage.irrigation, irrigation);
}

test("one absent meter never becomes a complete total", () => {
  const result = normalize(series([0.5, 0.5, 0.5, 0.5]), []);
  assert.equal(result.total, null);
  assert.equal(result.drinking, 2);
  assert.equal(result.irrigation, null);
  assert.equal(result.status, "partial");
  assert.equal(result.known.total, 2);
  assertCoverage(result, 4, 4, 0);
});

test("complete meter series produce full totals", () => {
  const result = normalize(series([1, 2, 3, 4]), series([4, 3, 2, 1]));
  assert.equal(result.drinking, 10);
  assert.equal(result.irrigation, 10);
  assert.equal(result.total, 20);
  assert.equal(result.status, "ready");
  assert.equal(result.buckets.length, 4);
  assertCoverage(result, 4, 4, 4);
});

test("real zero remains known and complete", () => {
  const result = normalize(series([0, 0, 0, 0]), series([0, 0, 0, 0]));
  assert.equal(result.total, 0);
  assert.equal(result.drinking, 0);
  assert.equal(result.irrigation, 0);
  assert.equal(result.status, "ready");
  assert.equal(result.known.total, 0);
  assertCoverage(result, 4, 4, 4);
});

test("empty series preserve all expected intervals as unknown", () => {
  const result = normalize([], []);
  assert.equal(result.status, "empty");
  assert.equal(result.total, null);
  assert.equal(result.known.total, null);
  assert.equal(result.buckets.length, 4);
  assert.ok(result.buckets.every((bucket) => bucket.drinking === null && bucket.irrigation === null));
  assertCoverage(result, 4, 0, 0);
});

test("a common interior gap and the change bridging it are both unknown", () => {
  const rows = series([1, 2, 3, 4]);
  rows.splice(2, 1);
  rows[2].change = 5;
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assert.equal(result.status, "partial");
  assert.equal(result.buckets.length, 4);
  assert.equal(result.buckets[1].drinking, null);
  assert.equal(result.buckets[2].drinking, null);
  assert.equal(result.known.drinking, 5);
  assertCoverage(result, 4, 2, 2);
});

test("unequal coverage does not borrow observations from the other meter", () => {
  const irrigation = series([1, 2, 3, 4]);
  irrigation.pop();
  const result = normalize(series([1, 2, 3, 4]), irrigation);
  assert.equal(result.drinking, 10);
  assert.equal(result.irrigation, null);
  assert.equal(result.total, null);
  assert.equal(result.known.irrigation, 6);
  assertCoverage(result, 4, 4, 3);
});

test("the first hour requires an immediately preceding baseline", () => {
  const rows = series([1, 2, 3, 4]).slice(1);
  rows[0].change = 101;
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assert.equal(result.buckets[0].drinking, null);
  assert.equal(result.known.drinking, 9);
  assertCoverage(result, 4, 3, 3);
});

test("a baseline older than one hour is insufficient", () => {
  const rows = series([1, 2, 3, 4]);
  rows[0].start -= HOUR;
  const result = normalize(rows, rows);
  assertCoverage(result, 4, 3, 3);
  assert.equal(result.total, null);
});

test("missing boundary hours are not excluded from expected coverage", () => {
  const rows = series([1, 2, 3, 4]);
  rows.splice(1, 1);
  rows.pop();
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assert.equal(result.buckets[0].drinking, null);
  assert.equal(result.buckets[3].drinking, null);
  assertCoverage(result, 4, 1, 1);
});

test("unordered observations normalize without changing coverage or sums", () => {
  const rows = series([1, 2, 3, 4]).reverse();
  const result = normalize(rows, rows);
  assert.equal(result.total, 20);
  assertCoverage(result, 4, 4, 4);
  assert.equal(result.buckets[0].start, START);
  assert.equal(result.buckets[3].start, START + 3 * HOUR);
});

test("out-of-window observations and the baseline do not inflate totals", () => {
  const rows = series([1, 2, 3, 4]);
  rows[0].change = 1_000;
  rows.push({ start: START + 4 * HOUR, change: 1_000, sum: 1_110 });
  rows.unshift({ start: START - 2 * HOUR, change: 1_000, sum: 99 });
  const result = normalize(rows, rows);
  assert.equal(result.total, 20);
  assertCoverage(result, 4, 4, 4);
});

test("null changes are not reconstructed from cumulative sum or state", () => {
  const rows = series([1, 2, 3, 4]);
  rows[2].change = null;
  rows[2].state = 1_003;
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assert.equal(result.buckets[1].drinking, null);
  assert.equal(result.known.drinking, 8);
  assertCoverage(result, 4, 3, 3);
});

test("invalid and negative changes are unknown rather than zero", () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, "unavailable", ""]) {
    const rows = series([1, 2, 3, 4]);
    rows[2].change = invalid;
    const result = normalize(rows, rows);
    assert.equal(result.total, null, `invalid change: ${String(invalid)}`);
    assert.equal(result.buckets[1].drinking, null);
    assertCoverage(result, 4, 3, 3);
  }
});

test("a missing sum prevents using that hour and its successor", () => {
  const rows = series([1, 2, 3, 4]);
  delete rows[2].sum;
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assertCoverage(result, 4, 2, 2);
});

test("duplicate timestamps conservatively invalidate the hour and its successor", () => {
  const rows = series([1, 2, 3, 4]);
  rows.push({ ...rows[2] });
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assert.equal(result.buckets[1].drinking, null);
  assert.equal(result.buckets[2].drinking, null);
  assertCoverage(result, 4, 2, 2);
});

test("malformed and non-hour-aligned timestamps cannot fill a missing hour", () => {
  const rows = series([1, 2, 3, 4]);
  rows[2].start += 1;
  rows.push({ start: null, change: 2, sum: 102 }, { start: Infinity, change: 2, sum: 102 });
  const result = normalize(rows, rows);
  assert.equal(result.total, null);
  assertCoverage(result, 4, 2, 2);
});

test("day aggregation cannot hide an interior hourly gap", () => {
  const rows = series(Array(48).fill(1));
  rows.splice(13, 1);
  const result = normalize(rows, rows, definition(48, "day"));
  assert.equal(result.total, null);
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].drinking, null);
  assert.equal(result.buckets[1].drinking, 24);
  assertCoverage(result, 48, 46, 46);
});

test("month aggregation cannot hide an interior hourly gap", () => {
  const start = Date.parse("2026-01-31T22:00:00Z");
  const rows = series([1, 1, 1, 1, 1], start);
  rows.splice(4, 1);
  const result = normalize(rows, rows, definition(5, "month", start));
  assert.equal(result.total, null);
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].drinking, 2);
  assert.equal(result.buckets[1].drinking, null);
  assertCoverage(result, 5, 3, 3);
});

test("closed-hour period boundaries do not request an unfinished interval", () => {
  const panel = makePanel();
  for (const key of ["24h", "7d", "30d", "12m"]) {
    const period = panel._periodDefinition(key);
    assert.equal(period.end.getTime(), Math.floor(NOW / HOUR) * HOUR);
    assert.equal(period.start.getTime() % HOUR, 0);
    assert.ok(period.start < period.end);
  }
  assert.equal(panel._periodDefinition("24h").end - panel._periodDefinition("24h").start, 24 * HOUR);
});

test("every Recorder request uses hours and one preceding baseline", async () => {
  for (const key of ["24h", "7d", "30d", "12m"]) {
    const panel = makePanel();
    const period = panel._periodDefinition(key);
    let request;
    panel._hass.callWS = async (message) => { request = message; return {}; };
    const load = await panel._loadPeriod(key);
    assert.equal(load.status, "complete");
    assert.equal(request.type, "recorder/statistics_during_period");
    assert.equal(request.period, "hour");
    assert.deepEqual(Array.from(request.types), ["change", "sum"]);
    assert.equal(request.start_time, new Date(period.start.getTime() - HOUR).toISOString());
    assert.equal(request.end_time, period.end.toISOString());
    assert.deepEqual(Array.from(request.statistic_ids), [DRINKING, IRRIGATION]);
  }
});

function surfaces(panel) {
  const overview = new NodeMock();
  const snapshot = overview.add('[data-snapshot="24h"]');
  for (const field of ["total", "drinking", "irrigation", "coverage"]) snapshot.add(`[data-snapshot-${field}]`);
  const consumption = new NodeMock();
  for (const field of ["total", "drinking", "irrigation", "coverage"]) consumption.add(`[data-stat-${field}]`);
  const chart = consumption.add("[data-chart-host]");
  panel._views.set("overview", overview);
  panel._views.set("consumption", consumption);
  panel._period = "24h";
  return { snapshot, consumption, chart };
}

test("both UI surfaces explicitly distinguish partial data from a full total", () => {
  const panel = makePanel();
  const { snapshot, consumption } = surfaces(panel);
  panel._statsLoads.set("24h", { status: "complete", result: normalize(series([1, 1, 1, 1]), []) });
  panel._patchSnapshot("24h");
  panel._renderActiveStatistics();
  assert.equal(snapshot.dataset.state, "partial");
  assert.equal(snapshot.querySelector("[data-snapshot-total]").textContent, "Неполные данные");
  assert.equal(consumption.querySelector("[data-stat-total]").textContent, "—");
  const coverage = consumption.querySelector("[data-stat-coverage]").textContent;
  assert.match(coverage, /Неполные данные/);
  assert.match(coverage, /4/);
  assert.match(coverage, /0/);
});

test("zero-valued complete statistics render ready rather than empty", () => {
  const panel = makePanel();
  const { snapshot, consumption } = surfaces(panel);
  panel._statsLoads.set("24h", { status: "complete", result: normalize(series([0, 0, 0, 0]), series([0, 0, 0, 0])) });
  panel._patchSnapshot("24h");
  panel._renderActiveStatistics();
  assert.equal(snapshot.dataset.state, "ready");
  assert.notEqual(snapshot.querySelector("[data-snapshot-total]").textContent, "Нет записей");
  assert.notEqual(consumption.querySelector("[data-stat-total]").textContent, "—");
});

test("loading and failure clear previously displayed completeness information", () => {
  const panel = makePanel();
  const { snapshot, consumption, chart } = surfaces(panel);
  panel._statsLoads.set("24h", { status: "complete", result: normalize(series([1, 1, 1, 1]), []) });
  panel._patchSnapshot("24h");
  panel._renderActiveStatistics();
  for (const status of ["loading", "error"]) {
    panel._statsLoads.set("24h", { status });
    panel._patchSnapshot("24h");
    panel._renderActiveStatistics();
    assert.equal(snapshot.dataset.state, status);
    assert.equal(consumption.querySelector("[data-stat-total]").textContent, "—");
    assert.doesNotMatch(consumption.querySelector("[data-stat-coverage]").textContent, /Неполные данные/);
    assert.doesNotMatch(snapshot.querySelector("[data-snapshot-coverage]").textContent, /Неполные данные/);
    assert.equal(chart.dataset.renderState, status);
  }
});

test("a period with no usable records renders empty rather than a zero total", () => {
  const panel = makePanel();
  const { snapshot, consumption, chart } = surfaces(panel);
  panel._statsLoads.set("24h", { status: "complete", result: normalize([], []) });
  panel._patchSnapshot("24h");
  panel._renderActiveStatistics();
  assert.equal(snapshot.dataset.state, "empty");
  assert.equal(snapshot.querySelector("[data-snapshot-total]").textContent, "Нет записей");
  assert.equal(consumption.querySelector("[data-stat-total]").textContent, "—");
  assert.match(chart.innerHTML, /Нет/);
});

test("chart retains common missing intervals without claiming zero use", () => {
  const panel = makePanel();
  const rows = series([1, 2, 3, 4]);
  rows.splice(2, 1);
  const result = normalize(rows, rows);
  const chart = panel._chartMarkup(result);
  assert.equal((chart.match(/class="bar-bucket"/g) || []).length, 4);
  for (const index of [1, 2]) {
    const title = panel._bucketTitle(result.buckets[index], "hour");
    assert.match(title, /питьевая —.*полив —/);
    assert.doesNotMatch(title, /\b0(?:[,.]0+)?\s*(?:л|м³)/);
  }
});

test("equal totals with shifted hourly values still redraw the chart", () => {
  const panel = makePanel();
  const { chart } = surfaces(panel);
  panel._statsLoads.set("24h", { status: "complete", result: normalize(series([1, 2, 3, 4]), series([0, 0, 0, 0])) });
  panel._renderActiveStatistics();
  const before = chart.innerHTML;
  panel._statsLoads.set("24h", { status: "complete", result: normalize(series([4, 3, 2, 1]), series([0, 0, 0, 0])) });
  panel._renderActiveStatistics();
  assert.notEqual(chart.innerHTML, before);
});

test("calendar buckets account for a daylight-saving 23-hour day", () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "Europe/Berlin";
    const start = new Date(2026, 2, 29).getTime();
    const end = new Date(2026, 2, 31).getTime();
    const hours = (end - start) / HOUR;
    assert.equal(hours, 47);
    const rows = series(Array(hours).fill(1), start);
    const result = normalize(rows, rows, definition(hours, "day", start));
    assert.equal(result.total, 94);
    assert.equal(result.buckets.length, 2);
    assert.equal(result.buckets[0].drinking, 23);
    assert.equal(result.buckets[1].drinking, 24);
    assertCoverage(result, 47, 47, 47);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("a skipped midnight does not split one calendar month into two buckets", () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "America/Santiago";
    assert.equal(new Date(2026, 8, 6).getHours(), 1, "fixture requires the skipped September midnight");
    const start = new Date(2026, 8, 5).getTime();
    const end = new Date(2026, 8, 7).getTime();
    const hours = (end - start) / HOUR;
    assert.equal(hours, 47);
    const rows = series(Array(hours).fill(1), start);
    const result = normalize(rows, rows, definition(hours, "month", start));
    assert.equal(result.total, 94);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].start, new Date(2026, 8, 1).getTime());
    assert.equal(result.buckets[0].drinking, 47);
    assertCoverage(result, 47, 47, 47);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("a full twelve-month request stays bounded and aggregates all covered hours", { timeout: 5_000 }, () => {
  const panel = makePanel();
  const period = panel._periodDefinition("12m");
  const hours = (period.end - period.start) / HOUR;
  assert.ok(hours > 8_000 && hours < 366 * 24);
  const rows = series(Array(hours).fill(1), period.start.getTime());
  const result = panel._normalizeStatistics(raw(rows, rows), period);
  assert.equal(result.status, "ready");
  assert.equal(result.total, hours * 2);
  assert.equal(result.buckets.length, 12);
  assertCoverage(result, hours, hours, hours);
});
