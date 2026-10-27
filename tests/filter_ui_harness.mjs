import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const registered = new Map();
class NodeMock {
  constructor() { this.nodes = new Map(); this.listeners = new Map(); this.dataset = {}; this.value = ''; this.textContent = ''; }
  querySelector(s) { return this.nodes.get(s) || null; }
  querySelectorAll(s) { return this.nodes.has(s) ? [this.nodes.get(s)] : []; }
  addEventListener(type, fn) { const handlers=this.listeners.get(type)||[];handlers.push(fn);this.listeners.set(type,handlers); }
  dispatchEvent(event) { for(const fn of this.listeners.get(event.type)||[]) fn(event); }
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

test('salt topup submits mass only and clears input on success',async()=>{
 const p=fixture();const root=p._views.get('filters');const kg=new NodeMock();kg.value='25';kg.reportValidity=()=>true;root.nodes.set('#salt-kg',kg);
 let sent;p._hass={callWS:async msg=>{sent=msg;return {revision:4};}};
 await p._filterAction({dataset:{filterAction:'salt_topup'},disabled:false});
 assert.equal(sent.action,'salt_topup');assert.equal(sent.payload.kg,25);assert.equal(sent.revision,3);assert.equal(kg.value,'');
});

function saltSnapshot(revision, kg = null) {
  return {revision, today:'2026-10-27', meter:353.456,
    settings:{people:3,hardness:null,softening_auto:true,
      main:{profile:'wound',volume:200,months:6,mode:'volume',date:null,baseline:null},
      cartridges:Object.fromEntries(['ferrostop','softening','postcarbon'].map(key=>[key,{months:6,date:null}])),
      salt:{model:'Ёлка WSC-0,5-Rx-(SC)',dose:1.5,check_days:6,level:'unknown',last_checked:null,
        last_added:kg === null ? null : '2026-10-27',last_added_kg:kg,
        history:kg === null ? [] : [{action:'topup',date:'2026-10-27',kg}]}},
    salt_status:{state:'unknown',days:null,estimated_remaining_kg:null},
    status:Object.fromEntries(['main','ferrostop','softening','postcarbon'].map(key=>[key,{state:'unconfigured',days:null,used:null,remaining:null,percent:null}]))};
}

function saltFixture() {
  const p=fixture();
  delete p._paintFilters; // Exercise real painting as well as request creation.
  p._filterData=saltSnapshot(3);
  const root=p._views.get('filters');
  for(const [id,value] of Object.entries({'salt-kg':'5','salt-level':'enough','salt-days':'6','salt-dose':'1.5'})) {
    const node=new NodeMock();node.value=value;node.reportValidity=()=>true;
    root.nodes.set('#'+id,node);
  }
  for(const [selector,node] of root.nodes) p.shadowRoot.nodes.set(selector,node);
  for(const selector of ['[data-salt-status]','[data-salt-detail]','[data-salt-history]','[data-salt-message]','[data-salt-card]'])
    p.shadowRoot.nodes.set(selector,new NodeMock());
  p._hass={user:{is_admin:true}};
  return p;
}

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('a topup during background refresh waits and saves once with the refreshed revision',async()=>{
  const p=saltFixture();const read=deferred();const sent=[];
  p._hass.callWS=async msg=>{
    sent.push(msg);
    return msg.action ? saltSnapshot(5,5) : read.promise;
  };
  const loading=p._loadFilters();
  const button={dataset:{filterAction:'salt_topup'},disabled:false};
  const saving=p._filterAction(button);
  await p._filterAction(button); // Duplicate press while the first awaits the read.
  read.resolve(saltSnapshot(4));
  await Promise.all([loading,saving]);
  assert.equal(sent.length,2);
  assert.equal(sent[1].action,'salt_topup');assert.equal(sent[1].revision,4);
  assert.equal(sent[1].payload.kg,5);
  assert.equal(p._filterData.settings.salt.last_added_kg,5);
  assert.match(p.shadowRoot.querySelector('[data-salt-detail]').textContent,/5 кг/);
  assert.match(p.shadowRoot.querySelector('[data-salt-message]').textContent,/5.*кг/);
  assert.equal(p._filterBusy,false);assert.equal(button.disabled,false);
});

test('salt write failure keeps the draft and confirmed revision with a nearby error',async()=>{
  const p=saltFixture();p._hass.callWS=async()=>{throw new Error('disk full');};
  await p._filterAction({dataset:{filterAction:'salt_topup'},disabled:false});
  assert.equal(p._views.get('filters').querySelector('#salt-kg').value,'5');
  assert.equal(p._filterData.revision,3);
  assert.equal(p._filterData.settings.salt.last_added_kg,null);
  assert.match(p.shadowRoot.querySelector('[data-salt-message]').textContent,/Не сохранено.*disk full/);
});

test('acknowledgement does not clear a newer salt draft typed during the write',async()=>{
  const p=saltFixture();const write=deferred();p._hass.callWS=()=>write.promise;
  const saving=p._filterAction({dataset:{filterAction:'salt_topup'},disabled:false});
  const input=p._views.get('filters').querySelector('#salt-kg');input.value='10';
  write.resolve(saltSnapshot(4,5));await saving;
  assert.equal(input.value,'10');
  assert.match(p.shadowRoot.querySelector('[data-salt-detail]').textContent,/5 кг/);
});

test('failed background read rejects a pending topup visibly without losing its mass',async()=>{
  const p=saltFixture();const read=deferred();const sent=[];
  p._hass.callWS=msg=>{sent.push(msg);return read.promise;};
  const loading=p._loadFilters();
  const button={dataset:{filterAction:'salt_topup'},disabled:false};
  const saving=p._filterAction(button);
  read.reject(new Error('offline'));
  await Promise.all([loading,saving]);
  assert.equal(sent.length,1);
  assert.equal(p._views.get('filters').querySelector('#salt-kg').value,'5');
  assert.match(p.shadowRoot.querySelector('[data-salt-message]').textContent,/Не сохранено/);
  assert.equal(p._filterBusy,false);assert.equal(button.disabled,false);
});

test('a new panel paints the saved topup while keeping inspection unknown',async()=>{
  const p=saltFixture();p._hass.callWS=async()=>saltSnapshot(4,5);
  await p._loadFilters();
  assert.match(p.shadowRoot.querySelector('[data-salt-detail]').textContent,/27\.10\.2026.*5 кг/);
  assert.match(p.shadowRoot.querySelector('[data-salt-history]').textContent,/досыпано 5 кг/);
  assert.match(p.shadowRoot.querySelector('[data-salt-status]').textContent,/ещё не проверен/);
});

test('a settings edit keeps its original revision across a background read to detect conflicts',async()=>{
  const p=saltFixture();const read=deferred();let submitted;
  p._hass.callWS=msg=>{
    if (!msg.action) return read.promise;
    submitted=msg;
    if (msg.revision !== 4) return Promise.reject(new Error('Настройки изменились'));
    return Promise.resolve(saltSnapshot(5));
  };
  const loading=p._loadFilters();
  const saving=p._filterAction({dataset:{filterAction:'settings'},disabled:false});
  read.resolve(saltSnapshot(4));await Promise.all([loading,saving]);
  assert.equal(submitted.revision,3);
  assert.match(p.shadowRoot.querySelector('[data-filter-message]').textContent,/Не сохранено.*Настройки изменились/);
});

test('a newly entered identical topup mass remains a draft after an earlier save',async()=>{
  const p=saltFixture();p._bindShellEvents();
  const write=deferred();p._hass.callWS=()=>write.promise;
  const saving=p._filterAction({dataset:{filterAction:'salt_topup'},disabled:false});
  const input=p._views.get('filters').querySelector('#salt-kg');input.id='salt-kg';
  input.value='10';p.shadowRoot.dispatchEvent({type:'input',target:input});
  input.value='5';p.shadowRoot.dispatchEvent({type:'input',target:input});
  write.resolve(saltSnapshot(4,5));await saving;
  assert.equal(input.value,'5');
  assert.equal(p._filterData.settings.salt.history.length,1);
});
