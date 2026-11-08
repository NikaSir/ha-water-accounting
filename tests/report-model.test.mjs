import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const path = new URL('../custom_components/water_accounting/frontend/src/report-model.js', import.meta.url);
const source = await readFile(path, 'utf8').catch(() => '');
const context = { Date, Intl, Map, Set, console };
vm.runInNewContext(source + '\n;globalThis.model = typeof WaterReportModel === "undefined" ? undefined : WaterReportModel;', context);
const model = context.model;
const HOUR = 3600000;
const NOW = Date.parse('2026-11-09T09:00:00Z');
const START = Date.parse('2026-09-30T21:00:00Z');
const END = Date.parse('2026-11-08T21:00:00Z');
const settings = {
  statistics_start_date: '2026-11-02', low_day_threshold_l: 100,
  regeneration_verified_from: '2026-10-01', regeneration_verified_through: '2026-11-08',
};
const amounts = {
  '2026-11-01': 400, '2026-11-02': 200, '2026-11-03': 0, '2026-11-04': 500,
  '2026-11-05': 90, '2026-11-06': 100, '2026-11-07': 600, '2026-11-08': 300,
};
const events = [
  {action: 'regeneration', date: '2026-11-04', water_m3: 0.1, result: 'unverified'},
  {action: 'regeneration', date: '2026-11-07', water_m3: 0.2, result: 'failed'},
];

function rowsFor(daily = amounts, start = START, end = END) {
  let sum = 1000;
  const rows = [{start: start-HOUR, sum, change: null}];
  for (let at = start; at < end; at += HOUR) {
    const key = new Date(at + 3*HOUR).toISOString().slice(0,10);
    const change = (daily[key] || 0)/24000;
    sum += change;
    rows.push({start: at, change, sum});
  }
  return rows;
}

function build(overrides = {}) {
  return model.build({now: NOW, settings, rows: rowsFor(),
    treatment: {revision: 8, settings: {salt: {history: events}}},
    treatmentAvailable: true, unit: 'm³', ...overrides});
}
const close = (actual, expected) => assert.ok(Math.abs(actual-expected)<0.00001, `${actual} != ${expected}`);

test('report model exposes the production entry points', () => {
  assert.equal(typeof model?.periods, 'function');
  assert.equal(typeof model?.build, 'function');
});

test('Moscow boundaries exclude the current local day regardless of browser timezone', () => {
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const p = model.periods(Date.parse('2026-11-08T22:00:00Z'), settings);
    assert.equal(p.today, '2026-11-09');
    assert.equal(p.end, '2026-11-08');
    assert.equal(p.requestStart, START);
    assert.equal(p.requestEnd, END);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('typical means use one filtered population and a weighted all-days mean', () => {
  const r = build();
  assert.equal(r.typical.included_days, 5);
  assert.equal(r.typical.excluded_days, 2);
  assert.equal(r.typical.groups.workday.days, 2);
  assert.equal(r.typical.groups.weekend.days, 2);
  assert.equal(r.typical.groups.holiday.days, 1);
  close(r.typical.groups.all.net_lpd, 280);
  close(r.typical.groups.all.gross_lpd, 340);
  close(r.typical.groups.workday.net_lpd, 150);
  close(r.typical.groups.weekend.net_lpd, 350);
  close(r.typical.groups.holiday.net_lpd, 400);
  assert.deepEqual(Array.from(r.typical.excluded, x=>x.date), ['2026-11-03','2026-11-05']);
});

test('monthly totals and daily means retain every zero and low-use day', () => {
  const m = build().months[0];
  assert.equal(m.expected_days, 8);
  assert.equal(m.complete_days, 8);
  assert.equal(m.status, 'complete');
  close(m.gross_m3, 2.19);
  close(m.net_m3, 1.89);
  close(m.gross_lpd, 273.75);
  close(m.net_lpd, 236.25);
  close(m.regeneration_m3, 0.3);
  assert.equal(m.cycles, 2);
  const previous = build().months[1];
  assert.equal(previous.expected_days, 31);
  assert.equal(previous.gross_m3, 0);
  assert.equal(previous.gross_lpd, 0);
});

test('a zero threshold still excludes true zero days from typical averages only', () => {
  const r = build({settings:{...settings,low_day_threshold_l:0}});
  assert.equal(r.typical.included_days,6);
  assert.deepEqual(Array.from(r.typical.excluded,x=>x.date),['2026-11-03']);
  assert.equal(r.months[0].expected_days,8);
  close(r.months[0].gross_m3,2.19);
});

test('one missing hour makes the month incomplete without erasing known partial volume', () => {
  const rows = rowsFor().filter(r=>r.start!==Date.parse('2026-11-05T06:00:00Z'));
  const r = build({rows});
  assert.equal(r.months[0].gross_m3, null);
  assert.equal(r.months[0].gross_lpd, null);
  assert.equal(r.months[0].status, 'partial');
  assert.ok(r.months[0].known_gross_m3 > 2);
  assert.ok(r.months[0].missing_dates.includes('2026-11-05'));
});

test('first day requires an immediately preceding baseline', () => {
  const rows = rowsFor().slice(1);
  const r = build({rows});
  assert.equal(r.months[1].gross_m3, null);
  assert.ok(r.months[1].missing_dates.includes('2026-10-01'));
});

test('duplicate hours cannot inflate a total or act as a valid next baseline', () => {
  const rows = rowsFor();
  rows.push({...rows.find(r=>r.start===Date.parse('2026-11-04T09:00:00Z'))});
  const r = build({rows});
  assert.equal(r.months[0].gross_m3, null);
  assert.ok(r.typical.excluded.some(x=>x.date==='2026-11-04'&&x.reason==='missing_data'));
});

test('negative and inconsistent changes remain unknown instead of being reconstructed', () => {
  const rows = rowsFor();
  rows.find(r=>r.start===Date.parse('2026-11-02T08:00:00Z')).change = -0.1;
  rows.find(r=>r.start===Date.parse('2026-11-07T08:00:00Z')).change = 4;
  const r = build({rows});
  assert.equal(r.months[0].gross_m3, null);
  assert.ok(r.typical.excluded.some(x=>x.date==='2026-11-02'));
  assert.ok(r.typical.excluded.some(x=>x.date==='2026-11-07'));
});

test('recorded water is usable regardless of the separate softening result', () => {
  const r = build();
  assert.equal(r.regenerations.cycles, 2);
  close(r.regenerations.volume_m3, 0.3);
  close(r.typical.groups.holiday.net_lpd, 400);
  close(r.typical.groups.weekend.net_lpd, 350);
});

test('unmeasured regeneration is never replaced with an assumed dose or refill water', () => {
  const treatment = {settings:{salt:{dose:1,history:[{action:'regeneration',date:'2026-11-07',
    estimated_water_m3:0.39,refill_l:5,result:'confirmed'}]}}};
  const r = build({treatment});
  assert.equal(r.months[0].gross_m3 !== null, true);
  assert.equal(r.months[0].net_m3, null);
  assert.equal(r.months[0].adjusted_m3, null);
  assert.ok(r.typical.excluded.some(x=>x.date==='2026-11-07'&&x.reason==='regeneration_unknown'));
  assert.equal(r.regenerations.cycles, 0);
});

test('same identified event is deducted once while conflicting same-date entries are ambiguous', () => {
  const event = {...events[1],id:'cycle-a'};
  const r = build({treatment:{settings:{salt:{history:[event,{...event}]}}}});
  assert.equal(r.regenerations.cycles,1);
  close(r.regenerations.volume_m3,0.2);
  const ambiguous = build({treatment:{settings:{salt:{history:[events[1],{...events[1]}]}}}});
  assert.equal(ambiguous.regenerations.cycles,0);
  assert.equal(ambiguous.months[0].net_m3,null);
  assert.ok(ambiguous.regenerations.issues.length>0);
});

test('identity conflicts outside the reporting window invalidate the affected completed cycle', () => {
  for(const otherDate of ['2026-11-09','2026-09-30']) {
    const history=[{id:'same-cycle',action:'regeneration',date:'2026-11-08',water_m3:0.1},
      {id:'same-cycle',action:'regeneration',date:otherDate,water_m3:0.1}];
    const r=build({treatment:{settings:{salt:{history}}}});
    close(r.months[0].gross_m3,2.19);
    assert.equal(r.months[0].net_m3,null);
    assert.ok(r.typical.excluded.some(x=>x.date==='2026-11-08'&&x.reason==='regeneration_unknown'));
    assert.ok(r.regenerations.issues.length>0);
  }
});

test('explicitly estimated volumes are not accepted as measured', () => {
  const r = build({treatment:{settings:{salt:{history:[{...events[1],water_basis:'estimated'}]}}}});
  assert.equal(r.regenerations.cycles,0);
  assert.equal(r.months[0].net_m3,null);
});

test('unverified journal interval gives a labeled residual but no confirmed clean total', () => {
  const r = build({settings:{...settings,regeneration_verified_from:null,regeneration_verified_through:null}});
  assert.equal(r.months[0].net_m3,null);
  close(r.months[0].adjusted_m3,1.89);
  assert.equal(r.typical.groups.all.net_lpd,null);
  close(r.typical.groups.all.adjusted_lpd,280);
  assert.ok(r.warnings.length>0);
});

test('unavailable journal cannot be interpreted as zero regeneration', () => {
  const r = build({treatment:null,treatmentAvailable:false});
  close(r.months[0].gross_m3,2.19);
  assert.equal(r.months[0].net_m3,null);
  assert.equal(r.months[0].adjusted_m3,null);
  assert.equal(r.typical.included_days,0);
});

test('volume exceeding its full-day total is an error, never a clamped zero', () => {
  const r = build({treatment:{settings:{salt:{history:[{...events[1],water_m3:1}]}}}});
  assert.equal(r.months[0].net_m3,null);
  assert.ok(r.typical.excluded.some(x=>x.date==='2026-11-07'&&x.reason==='regeneration_exceeds_total'));
});

test('events in unfinished days and outside report bounds are not deducted', () => {
  const r = build({treatment:{settings:{salt:{history:[...events,
    {action:'regeneration',date:'2026-11-09',water_m3:0.4},
    {action:'regeneration',date:'2026-09-01',water_m3:0.4}]}}}});
  close(r.months[0].net_m3,1.89);
  assert.equal(r.regenerations.cycles,2);
});

test('litre Recorder units normalize and unsupported units stay unknown', () => {
  const rows = rowsFor().map(r=>({...r,sum:r.sum*1000,change:r.change===null?null:r.change*1000}));
  close(build({rows,unit:'L'}).months[0].gross_m3,2.19);
  const r = build({unit:'kWh'});
  assert.equal(r.months[0].gross_m3,null);
  assert.ok(r.warnings.length>0);
});

test('Russian production calendar separates holidays and transferred work/rest days', () => {
  assert.equal(model.classifyDate('2026-11-04').kind,'holiday');
  assert.equal(model.classifyDate('2026-01-09').kind,'weekend');
  assert.equal(model.classifyDate('2026-12-31').kind,'weekend');
  assert.equal(model.classifyDate('2025-11-01').kind,'workday');
  assert.equal(model.classifyDate('2025-11-03').kind,'weekend');
  assert.equal(model.classifyDate('2026-11-07').kind,'weekend');
  assert.equal(model.classifyDate('2026-11-06').kind,'workday');
});

test('unknown calendar years are explicitly unverified', () => {
  assert.equal(model.classifyDate('2032-11-01').known,false);
});

test('previous Monday comparison is reconstructed and no nonexistent snapshot is claimed', () => {
  const daily = {};
  for(let d=27;d<=31;d++)daily[`2026-10-${d}`]=200;
  for(let d=1;d<=7;d++)daily[`2026-11-0${d}`]=d===7?400:200;
  const r = build({now:Date.parse('2026-11-08T09:00:00Z'),settings:{...settings,statistics_start_date:'2026-10-27'},
    rows:rowsFor(daily),treatment:{settings:{salt:{history:[]}}}});
  assert.equal(r.comparison.available,true);
  assert.equal(r.comparison.as_of,'2026-11-02');
  assert.equal(r.comparison.kind,'reconstructed');
  close(r.comparison.delta_all.net_lpd,16.6666666667);
});

test('first day of month has zero completed current-month days, not a fake zero total', () => {
  const r = build({now:Date.parse('2026-11-01T09:00:00Z'),settings:{...settings,statistics_start_date:'2026-10-01'}});
  assert.equal(r.months[0].expected_days,0);
  assert.equal(r.months[0].gross_m3,null);
  assert.equal(r.months[0].gross_lpd,null);
});
