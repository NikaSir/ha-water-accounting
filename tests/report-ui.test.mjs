import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../custom_components/water_accounting/frontend/water-accounting-panel.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-08T12:00:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const registry = new Map();
const storage = {getItem: () => null, setItem() {}};
const context = {
  HTMLElement: class { attachShadow() { this.shadowRoot = {querySelector: () => null, querySelectorAll: () => []}; } },
  customElements: {get: name => registry.get(name), define: (name, ctor) => registry.set(name, ctor)},
  window: {setTimeout, clearTimeout}, localStorage: storage, sessionStorage: storage,
  MutationObserver: class {observe() {} disconnect() {}},
  document: {documentElement: {}, children: []}, Node: {ELEMENT_NODE: 1},
  Date: FixedDate, Intl, URL, console, setTimeout, clearTimeout,
};
vm.runInNewContext(source, context);
const Panel = registry.get('nikas-water-accounting-panel');
const copy = value => JSON.parse(JSON.stringify(value));
const initial = () => ({revision: 0, settings: {statistics_start_date: '2026-10-27', low_day_threshold_l: 100,
  regeneration_verified_from: '2026-10-27', regeneration_verified_through: '2026-11-07',
  irrigation: {enabled: true, reason: '', since: null}}});
function make(callWS, admin = true) {
  const panel = new Panel();
  panel._queuePatch = () => {};
  panel._hass = {callWS, user: {is_admin: admin}, states: {}, locale: {language: 'ru'}};
  return panel;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

test('planned shutdown takes effect only after a successful server save', async () => {
  const pending = deferred();
  let sent;
  const panel = make(message => {
    if (message.action === 'get') return Promise.resolve(initial());
    sent = message;
    return pending.promise;
  });
  await panel._loadAccountSettings();
  panel._settingsDraft.irrigation = {enabled: false, reason: 'На зиму', since: '2026-11-01'};
  panel._settingsDirty = true;
  assert.equal(panel._irrigationInactive(), false);
  const saving = panel._saveAccountSettings();
  assert.equal(panel._irrigationInactive(), false);
  assert.equal(sent.action, 'update');
  assert.equal(sent.revision, 0);
  assert.deepEqual(copy(sent.payload), copy(panel._settingsDraft));
  pending.resolve({revision: 1, settings: copy(sent.payload)});
  assert.equal(await saving, true);
  assert.equal(panel._irrigationInactive(), true);
  assert.equal(panel._settingsDirty, false);
});

test('background reads do not race an in-flight save or discard its acknowledgement', async () => {
  const pending = deferred();
  let gets = 0;
  const panel = make(message => {
    if (message.action === 'get') { gets++; return Promise.resolve(initial()); }
    return pending.promise;
  });
  await panel._loadAccountSettings();
  panel._settingsDraft.low_day_threshold_l = 150;
  panel._settingsDirty = true;
  const saving = panel._saveAccountSettings();
  await panel._loadAccountSettings(true);
  assert.equal(gets, 1);
  pending.resolve({revision: 1, settings: copy(panel._settingsDraft)});
  assert.equal(await saving, true);
  assert.equal(panel._accountSettings.settings.low_day_threshold_l, 150);
});

test('settings polling resumes when its timer fires during a pending save', async () => {
  const timers = new Map();
  let next = 0;
  const oldSet = context.window.setTimeout, oldClear = context.window.clearTimeout;
  context.window.setTimeout = (callback, delay) => {const id = ++next; timers.set(id, {callback, delay}); return id;};
  context.window.clearTimeout = id => timers.delete(id);
  try {
    const pending = deferred();
    const panel = make(message => message.action === 'get' ? Promise.resolve(initial()) : pending.promise);
    panel.isConnected = true;
    await panel._loadAccountSettings();
    panel._settingsDraft.low_day_threshold_l = 135;
    panel._settingsDirty = true;
    const save = panel._saveAccountSettings();
    const timer = timers.get(panel._settingsTimer);
    timers.delete(panel._settingsTimer);
    timer.callback();
    pending.resolve({revision: 1, settings: copy(panel._settingsDraft)});
    assert.equal(await save, true);
    assert.equal(timers.get(panel._settingsTimer)?.delay, 60000, 'Shared settings must keep polling after a save');
  } finally {
    context.window.setTimeout = oldSet;
    context.window.clearTimeout = oldClear;
  }
});

test('refresh and revision conflict preserve draft and its original revision', async () => {
  let state = initial();
  const panel = make(message => message.action === 'get' ? Promise.resolve(copy(state)) : Promise.reject({code: 'revision_conflict'}));
  await panel._loadAccountSettings();
  panel._settingsDraft.low_day_threshold_l = 135;
  panel._settingsDirty = true;
  state.revision = 1;
  state.settings.low_day_threshold_l = 200;
  await panel._loadAccountSettings(true);
  assert.equal(panel._settingsDraft.low_day_threshold_l, 135);
  assert.equal(panel._settingsDraftRevision, 0);
  assert.equal(await panel._saveAccountSettings(), false);
  assert.equal(panel._settingsConflict, true);
  assert.equal(panel._settingsDraft.low_day_threshold_l, 135);
  assert.equal(panel._settingsDraftRevision, 0);
  await panel._reloadAccountDraft();
  assert.equal(panel._settingsConflict, false);
  assert.equal(panel._settingsDraft.low_day_threshold_l, 200);
  assert.equal(panel._settingsDraftRevision, 1);
});

test('failed reads clear a persisted outage mask and do not lose the edited draft', async () => {
  const state = initial();
  state.settings.irrigation = {enabled: false, reason: 'Ремонт', since: '2026-11-01'};
  let failure = false;
  const panel = make(() => {
    if (failure) throw {code: 'storage_error'};
    return Promise.resolve(state);
  });
  await panel._loadAccountSettings();
  assert.equal(panel._irrigationInactive(), true);
  panel._settingsDraft.low_day_threshold_l = 123;
  panel._settingsDirty = true;
  failure = true;
  await panel._reloadAccountDraft();
  assert.equal(panel._irrigationInactive(), false);
  assert.equal(panel._settingsDraft.low_day_threshold_l, 123);
  assert.equal(panel._settingsDirty, true);
  assert.equal(panel._settingsPromise, null);
});

test('failed saves retain the draft and never apply its desired outage', async () => {
  const panel = make(message => message.action === 'get' ? Promise.resolve(initial()) : Promise.reject({code: 'storage_error'}));
  await panel._loadAccountSettings();
  panel._settingsDraft.irrigation = {enabled: false, reason: 'Ремонт', since: '2026-11-01'};
  panel._settingsDirty = true;
  assert.equal(await panel._saveAccountSettings(), false);
  assert.equal(panel._irrigationInactive(), false);
  assert.equal(panel._settingsDraft.irrigation.enabled, false);
  assert.equal(panel._settingsDirty, true);
});

test('non-administrators never send settings writes', async () => {
  const calls = [];
  const panel = make(message => {calls.push(message); return Promise.resolve(initial());}, false);
  await panel._loadAccountSettings();
  panel._settingsDirty = true;
  assert.equal(await panel._saveAccountSettings(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'get');
});

test('late read after disconnect cannot re-enable stale outage masking', async () => {
  const pending = deferred();
  const panel = make(() => pending.promise);
  const read = panel._loadAccountSettings();
  await Promise.resolve();
  panel._disconnectAccountUI();
  const state = initial();
  state.settings.irrigation = {enabled: false, reason: 'На зиму', since: '2026-11-01'};
  pending.resolve(state);
  assert.equal(await read, null);
  assert.equal(panel._irrigationInactive(), false);
});

test('report requests explicit volume units and Moscow full days; journal failure keeps gross totals', async () => {
  const calls = [];
  const panel = make(message => {
    calls.push(message);
    if (message.type === 'water_accounting/settings') return Promise.resolve(initial());
    if (message.type === 'water_treatment/filters') return Promise.reject({code: 'unknown_command'});
    const start = Date.parse(message.start_time), end = Date.parse(message.end_time);
    let sum = 100;
    return Promise.resolve({[message.statistic_ids[0]]: Array.from({length: (end-start)/3600000}, (_, index) => {
      sum += 0.01;
      return {start: start+index*3600000, change: 0.01, sum};
    })});
  });
  const load = await panel._loadWaterReport();
  assert.equal(load.status, 'complete');
  const request = calls.find(item => item.type === 'recorder/statistics_during_period');
  assert.equal(request.units.volume, 'm³');
  assert.equal(request.start_time, '2026-09-30T20:00:00.000Z');
  assert.equal(request.end_time, '2026-11-07T21:00:00.000Z');
  assert.equal(load.result.regenerations.available, false);
  assert.equal(load.result.months[0].net_m3, null);
  assert.ok(Math.abs(load.result.months[0].gross_m3 - 1.68) < 1e-9);
  assert.match(panel._reportMarkup(load.result), /Чистый расход не установлен/);
});

function reportFixture({windowError = false} = {}) {
  const calls = [];
  const panel = make(message => {
    calls.push(message);
    if (message.type === 'water_accounting/settings') return Promise.resolve(initial());
    if (message.type === 'water_treatment/filters') return Promise.resolve({revision: 7, settings: {salt: {history: [
      {action: 'regeneration', date: '2026-11-04', water_m3: 0.99},
      {action: 'regeneration', date: '2026-11-08'},
    ]}}});
    if (message.type === 'water_accounting/regeneration_windows') {
      if (windowError) return Promise.reject({code: 'unknown_command'});
      return Promise.resolve({entity_id: message.entity_id,
        window: {start: '02:30', end: '04:30', timezone: 'Europe/Moscow'},
        measurements: Object.fromEntries(message.dates.map(date => [date, {date, status: 'measured',
          water_m3: 0.3, start_meter_m3: 100, end_meter_m3: 100.3,
          start_time: date + 'T02:30:00+03:00', end_time: date + 'T04:30:00+03:00', source: 'recorder_history'}]))});
    }
    const start = Date.parse(message.start_time), end = Date.parse(message.end_time);
    let sum = 100;
    return Promise.resolve({[message.statistic_ids[0]]: Array.from({length: (end-start)/3600000}, (_, index) => {
      sum += 0.02;
      return {start: start+index*3600000, change: 0.02, sum};
    })});
  });
  return {panel, calls};
}

test('report loads recorded date windows and includes November 4 as a holiday', async () => {
  const {panel, calls} = reportFixture();
  const load = await panel._loadWaterReport();
  assert.equal(load.status, 'complete');
  const request = calls.find(item => item.type === 'water_accounting/regeneration_windows');
  assert.ok(request, 'Recorded cycles need the exact regeneration window endpoint');
  assert.deepEqual(copy(request.dates), ['2026-11-04', '2026-11-08']);
  assert.equal(request.entity_id, panel._config().entities.drinking_total);
  assert.equal(load.result.typical.groups.holiday.calendar_days, 1);
  assert.equal(load.result.typical.groups.holiday.days, 1);
  assert.ok(Math.abs(load.result.typical.groups.holiday.adjusted_lpd - 180) < 1e-7);
  assert.ok(Math.abs(load.result.regenerations.volume_m3 - 0.3) < 1e-9, 'Journal manual value must not replace the new window');
  assert.match(panel._reportMarkup(load.result), /02:30–04:30/);
  assert.match(panel._reportMarkup(load.result), /04\.11\.2026/);
});

test('missing window API leaves gross report usable and explains the excluded holiday', async () => {
  const {panel} = reportFixture({windowError: true});
  const load = await panel._loadWaterReport();
  assert.equal(load.status, 'complete');
  assert.equal(load.result.typical.groups.holiday.calendar_days, 1);
  assert.equal(load.result.typical.groups.holiday.days, 0);
  assert.equal(load.result.regenerations.volume_m3, null);
  assert.equal(load.result.regenerations.unknown_cycles, 1);
  assert.ok(Math.abs(load.result.months[0].gross_m3 - 3.36) < 1e-8);
  const html = panel._reportMarkup(load.result);
  assert.match(html, /Учтено: 0 из 1/);
  assert.match(html, /04\.11\.2026: неизвестен объём регенерац/);
  assert.match(html, /Без подтверждённого объёма: 1/);
});
