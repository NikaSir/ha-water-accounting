// Local real-browser acceptance; the production bundle runs with synthetic HA responses.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
let playwright;
try { playwright=await import('playwright'); }
catch(error) {
  if(!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES)throw error;
  playwright=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/package.json')('playwright-core');
}
const output=resolve(process.env.WATER_BROWSER_OUTPUT || resolve(root,'../qa/water-statistics'));
await mkdir(output,{recursive:true});
const server=createServer(async(request,response)=>{
  try {
    const url=new URL(request.url,'http://localhost');
    const file=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+sep)){response.writeHead(403);response.end();return;}
    response.setHeader('Content-Type',{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
      '.css':'text/css','.png':'image/png'}[extname(file)]||'application/octet-stream');
    response.end(await readFile(file));
  } catch {response.writeHead(404);response.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
try {
  browser=await playwright.chromium.launch({headless:true,
    executablePath:process.env.WATER_BROWSER_EXECUTABLE||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'ru-RU',timezoneId:'America/Los_Angeles'});
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const by=selector=>page.locator('nikas-water-accounting-panel').locator(selector);
  const tick=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const open=async(view)=>{await by('.tabbar [data-view="'+view+'"]').click();await tick();};
  await page.goto(origin+'/preview/index.html?view=statistics');
  await by('.page-statistics').waitFor({state:'visible'});
  await tick();
  assert.deepEqual(await by('.tabbar [data-view]').evaluateAll(nodes=>nodes.map(n=>n.dataset.view)),
    ['overview','consumption','statistics','meters','settings']);
  const reportRequests=await page.evaluate(()=>previewRequests.filter(r=>r.type==='recorder/statistics_during_period'&&r.units));
  assert.ok(reportRequests.length>0,'Statistics must request Recorder with explicit volume units');
  assert.equal(reportRequests.at(-1).units.volume,'m³');
  assert.equal(reportRequests.at(-1).end_time,'2026-11-07T21:00:00.000Z');
  assert.ok((await by('.page-statistics').innerText()).includes('Europe/Moscow'));
  await by('[data-calendar-group="holiday"]').waitFor({state:'visible'});
  assert.match(await by('[data-calendar-group="holiday"]').innerText(),/Учтено: 1 из 1/);
  assert.match(await by('[data-calendar-group="holiday"]').innerText(),/04\.11\.2026/);
  assert.match(await by('.page-statistics').innerText(),/02:30–04:30/);

  for(const size of [{width:390,height:844},{width:430,height:932},{width:932,height:430},{width:768,height:1024},{width:1440,height:900}]) {
    await page.setViewportSize(size);
    for(const view of ['overview','consumption','statistics','meters','settings']) {
      await open(view);
      const geometry=await page.evaluate(()=>{
        const root=document.querySelector('nikas-water-accounting-panel').shadowRoot;
        const viewport=root.querySelector('.canvas-viewport');
        const header=root.querySelector('.nikas-shell__header');
        const footer=root.querySelector('.tabbar');
        const before={header:header.getBoundingClientRect().y,footer:footer.getBoundingClientRect().y};
        viewport.scrollTop=viewport.scrollHeight;
        return {width:viewport.clientWidth,scrollWidth:viewport.scrollWidth,
          headerDelta:header.getBoundingClientRect().y-before.header,footerDelta:footer.getBoundingClientRect().y-before.footer,
          bodyWidth:document.body.scrollWidth,windowWidth:innerWidth,
          overflowing:Array.from(root.querySelectorAll('.page:not([hidden]) *')).filter(node=>node.getBoundingClientRect().right>viewport.getBoundingClientRect().right+1)
            .slice(0,10).map(node=>({tag:node.tagName,cls:node.className,text:node.textContent.slice(0,70),width:node.getBoundingClientRect().width}))};
      });
      assert.ok(geometry.scrollWidth<=geometry.width+1,`${view} overflows at ${size.width}: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bodyWidth<=geometry.windowWidth+1,`Outer page overflows in ${view}`);
      assert.equal(geometry.headerDelta,0,'Header is fixed during internal scroll');
      assert.equal(geometry.footerDelta,0,'Footer is fixed during internal scroll');
    }
  }
  await page.setViewportSize({width:390,height:844});
  await open('statistics');
  await page.evaluate(()=>document.querySelector('nikas-water-accounting-panel').shadowRoot.querySelector('.canvas-viewport').scrollTop=0);
  await page.screenshot({path:resolve(output,'statistics-mobile.png')});
  await open('settings');
  await page.evaluate(()=>document.querySelector('nikas-water-accounting-panel').shadowRoot.querySelector('.canvas-viewport').scrollTop=0);
  await page.screenshot({path:resolve(output,'settings-mobile.png')});

  // Even without a measured window, the holiday remains visible with its exclusion reason.
  await page.goto(origin+'/preview/index.html?view=statistics&missing-window=1');
  await by('[data-calendar-group="holiday"]').waitFor({state:'visible'});
  assert.match(await by('[data-calendar-group="holiday"]').innerText(),/Учтено: 0 из 1/);
  assert.match(await by('[data-calendar-group="holiday"]').innerText(),/04\.11\.2026: неизвестен объём регенерац/);
  await by('[data-calendar-group="holiday"]').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,'holiday-missing-window-mobile.png')});

  // A deliberate outage must be neutral, while drinking-water faults remain faults.
  await page.goto(origin+'/preview/index.html?view=overview&disabled=1');
  await by('.page-overview').waitFor({state:'visible'});
  await tick();
  const off=await page.evaluate(()=>document.querySelector('nikas-water-accounting-panel')._pressureEvaluation('irrigation'));
  assert.ok(!['bad','warn','unknown'].includes(off.tone),JSON.stringify(off));
  assert.match(await by('[data-pressure-status="irrigation"]').innerText(),/отключ/i);
  assert.doesNotMatch(await by('[data-overall-title]').innerText(),/внимание|не все|отклонение/i);
  await page.evaluate(()=>{
    const panel=document.querySelector('nikas-water-accounting-panel');
    const id=panel._config().entities.pressure_drinking;
    panel.hass={...panel.hass,states:{...panel.hass.states,[id]:{...panel.hass.states[id],state:'2.0'}}};
  });
  await tick();
  assert.equal(await page.evaluate(()=>panel._pressureEvaluation('drinking').tone),'warn');
  assert.equal(await page.evaluate(()=>panel._pressureEvaluation('irrigation').tone),'inactive');
  assert.match(await by('[data-overall-title]').innerText(),/отклонение/i);
  await page.evaluate(()=>{
    const panel=document.querySelector('nikas-water-accounting-panel');
    const id=panel._config().entities.pressure_drinking;
    panel.hass={...panel.hass,states:{...panel.hass.states,[id]:{...panel.hass.states[id],state:'0'}}};
  });
  await tick();
  assert.match(await by('[data-overall-title]').innerText(),/внимание/i);
  assert.equal(await page.evaluate(()=>document.querySelector('nikas-water-accounting-panel')._pressureEvaluation('drinking').tone),'bad');
  await open('meters');
  assert.match(await by('[data-meter-badge="irrigation"]').innerText(),/отключ/i);
  assert.equal(await by('[data-diagnostic-role]').count(),13,'Merged meters retains all diagnostic roles');

  // Preserve the actual mounted nodes during a telemetry patch.
  await page.evaluate(()=>{
    const panel=document.querySelector('nikas-water-accounting-panel');
    window.beforePatch={header:panel.shadowRoot.querySelector('.nikas-shell__header'),
      footer:panel.shadowRoot.querySelector('.tabbar'),view:panel.shadowRoot.querySelector('.page-meters')};
    panel.hass={...panel.hass,states:{...panel.hass.states}};
  });
  await tick();
  assert.equal(await page.evaluate(()=>{
    const root=document.querySelector('nikas-water-accounting-panel').shadowRoot;
    return beforePatch.header===root.querySelector('.nikas-shell__header')&&beforePatch.footer===root.querySelector('.tabbar')
      &&beforePatch.view===root.querySelector('.page-meters');
  }),true);

  // Exercise the real form: a draft is not an authoritative shutdown.
  await page.goto(origin+'/preview/index.html?view=settings');
  await by('#irrigation-enabled').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('nikas-water-accounting-panel')._settingsTrusted);
  await by('#irrigation-enabled').selectOption('false');
  await by('#irrigation-reason').fill('На зиму');
  await by('#irrigation-since').fill('2026-11-01');
  assert.equal(await page.evaluate(()=>panel._irrigationInactive()),false,'An unsaved draft must not mask faults');
  await page.evaluate(()=>{
    const original=panel.hass.callWS;
    window.originalPreviewWS=original;
    panel.hass={...panel.hass,callWS:message=>message.type==='water_accounting/settings'&&message.action==='update'
      ? new Promise((resolve,reject)=>{window.pendingSettingsSave={message,resolve,reject};}) : original(message)};
  });
  assert.match(await by('[data-irrigation-draft]').innerText(),/после сохранения/);
  await by('[data-settings-save]').first().click();
  await page.waitForFunction(()=>window.pendingSettingsSave&&panel._settingsSaving);
  await tick();
  assert.deepEqual(await by('[data-settings-save]').evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true]);
  assert.equal(await page.evaluate(()=>panel._irrigationInactive()),false);
  await page.evaluate(async()=>{
    pendingSettingsSave.resolve(await originalPreviewWS(pendingSettingsSave.message));
    panel.hass={...panel.hass,callWS:originalPreviewWS};
  });
  await page.waitForFunction(()=>panel._irrigationInactive());
  await tick();
  assert.match(await by('[data-settings-status]').innerText(),/сохранены/);

  await by('#irrigation-reason').fill('На зиму, до весны');
  assert.match(await by('[data-irrigation-draft]').innerText(),/Текущее состояние линии продолжает действовать/);
  assert.equal(await page.evaluate(()=>panel._irrigationInactive()),true);

  // Telemetry and an explicit refresh preserve an edited field and its base revision.
  await by('#stat-low').fill('135');
  await by('#stat-low').focus();
  await page.evaluate(()=>panel.hass={...panel.hass,states:{...panel.hass.states}});
  await tick();
  assert.equal(await by('#stat-low').inputValue(),'135');
  assert.equal(await page.evaluate(()=>panel.shadowRoot.activeElement.id),'stat-low');
  await page.evaluate(()=>{
    settingsSnapshot={revision:settingsSnapshot.revision+1,settings:{...settingsSnapshot.settings,low_day_threshold_l:200}};
  });
  await by('#refresh').click();
  await page.waitForFunction(()=>!panel._refreshing);
  assert.equal(await by('#stat-low').inputValue(),'135');
  await by('[data-settings-save]').last().click();
  await page.waitForFunction(()=>panel._settingsConflict&&!panel._settingsSaving);
  await tick();
  assert.equal(await by('#stat-low').inputValue(),'135');
  assert.match(await by('[data-settings-status]').innerText(),/другом окне/);
  assert.equal(await by('[data-settings-save]').first().isDisabled(),true);
  await by('[data-settings-action="reload"]').click();
  await page.waitForFunction(()=>!panel._settingsConflict&&!panel._settingsPromise);
  await tick();
  assert.equal(await by('#stat-low').inputValue(),'200');

  // Re-enabling resumes the exact ordinary pressure rules.
  await page.evaluate(()=>{
    const id=panel._config().entities.pressure_irrigation;
    panel.hass={...panel.hass,states:{...panel.hass.states,[id]:{...panel.hass.states[id],state:'0'}}};
  });
  await by('#irrigation-enabled').selectOption('true');
  await by('[data-settings-save]').first().click();
  await page.waitForFunction(()=>!panel._settingsSaving&&!panel._settingsDirty);
  assert.equal(await page.evaluate(()=>panel._pressureEvaluation('irrigation').tone),'bad');

  // An unavailable settings read fails open to ordinary monitoring, not a stale mask.
  await page.goto(origin+'/preview/index.html?view=settings&disabled=1');
  await page.waitForFunction(()=>panel._settingsTrusted);
  assert.equal(await page.evaluate(()=>panel._irrigationInactive()),true);
  await page.evaluate(async()=>{
    const original=panel.hass.callWS;
    panel.hass={...panel.hass,callWS:message=>message.type==='water_accounting/settings'
      ? Promise.reject({code:'storage_error'}) : original(message)};
    await panel._loadAccountSettings(true);
  });
  await tick();
  assert.equal(await page.evaluate(()=>panel._irrigationInactive()),false);
  assert.equal(await page.evaluate(()=>panel._pressureEvaluation('irrigation').tone),'bad');
  assert.match(await by('[data-settings-status]').innerText(),/не удалось/i);

  // Non-administrators can inspect but cannot submit settings.
  await page.goto(origin+'/preview/index.html?view=settings&readonly=1');
  await page.waitForFunction(()=>panel._settingsTrusted);
  assert.equal(await by('#irrigation-enabled').isDisabled(),true);
  assert.equal(await by('[data-settings-save]').first().isDisabled(),true);
  assert.match(await by('[data-settings-status]').innerText(),/администратора/);
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.type==='water_accounting/settings'&&r.action==='update').length),0);
  assert.deepEqual(errors,[]);
  console.log('Browser acceptance passed: 25 viewport/tab combinations, exact regeneration windows, visible November 4 and exclusion reasons, outages, drinking 2.0 warning, stable nodes, delayed save, dirty focus, refresh, revision conflict, reload, re-enable, failed reads and read-only access.');
} finally {
  if(browser)await browser.close();
  await new Promise(done=>server.close(done));
}
