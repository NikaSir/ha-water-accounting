import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const registered = new Map();
class NodeMock {
  constructor() { this.nodes = new Map(); this.dataset = {}; this.value = ''; this.textContent = ''; }
  querySelector(s) { return this.nodes.get(s) || null; }
  querySelectorAll(s) { return this.nodes.has(s) ? [this.nodes.get(s)] : []; }
}
const context = { HTMLElement: class { attachShadow() { this.shadowRoot = new NodeMock(); } },
  customElements: { get: n => registered.get(n), define: (n,c) => registered.set(n,c) },
  localStorage: {getItem:()=>null}, window: {setTimeout,clearTimeout},
  MutationObserver: class { observe() {} disconnect() {} }, Node: { ELEMENT_NODE: 1 }, document: {documentElement:{},children:[]}, Intl, Date, URL, setTimeout, clearTimeout };
vm.createContext(context);
vm.runInContext(await readFile(new URL('../custom_components/water_accounting/frontend/water-accounting-panel.js',import.meta.url),'utf8'),context);
const Panel = registered.get('nikas-water-accounting-panel');
function fixture() {
  const p = new Panel(); const root = new NodeMock(); p._views.set('filters',root);
  for(const [id,value] of Object.entries({'filter-profile':'wound','filter-volume':'200','filter-months':'6','filter-mode':'volume','filter-people':'3','filter-hardness':'4.1','filter-auto':'auto','months-ferrostop':'6','months-softening':'6','months-postcarbon':'6'})) {
    const node=new NodeMock();node.value=value;root.nodes.set('#'+id,node);
  }
  p._filterData={revision:3};p._paintFilters=()=>{};
  p.shadowRoot.nodes.set('[data-filter-message]',new NodeMock());
  return p;
}
test('settings submit custom controls and revision without replacement baseline',async()=>{
  const p=fixture();let sent;p._hass={callWS:async msg=>{sent=msg;return {revision:4};}};
  await p._filterAction({dataset:{filterAction:'settings'},disabled:false});
  assert.equal(sent.payload.main.volume,200);assert.equal(sent.payload.people,3);
  assert.equal(sent.payload.hardness,4.1);assert.equal(sent.revision,3);
  assert.equal(sent.payload.main.baseline,undefined);assert.equal(sent.payload.main.date,undefined);
});
test('failed save preserves loaded revision and reports failure',async()=>{
  const p=fixture();p._hass={callWS:async()=>{throw new Error('conflict');}};
  await p._filterAction({dataset:{filterAction:'settings'},disabled:false});
  assert.equal(p._filterData.revision,3);
  assert.match(p.shadowRoot.querySelector('[data-filter-message]').textContent,/Не сохранено: conflict/);
});
test('refresh failure clears stale success rather than showing resource as current',async()=>{
  const p=fixture();p._hass={callWS:async()=>{throw new Error('offline');}};
  await p._loadFilters();assert.equal(p._filterData,null);
  assert.match(p.shadowRoot.querySelector('[data-filter-message]').textContent,/offline/);
});
