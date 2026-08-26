import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {
  availablePort,
  chromeExecutable,
  createActiveSubscriptionPage,
  stopProcess,
  waitForReady,
} from './browser-server-harness.js';
import {
  createReleaseServerEnvironment, prepareReleaseBrowserBoundary,
} from './aisy-learner-release-safety.js';

const projectDirectory=fileURLToPath(new URL('..',import.meta.url));
const serverPath=fileURLToPath(new URL('../server.js',import.meta.url));
const jwtSecret='aisy-accessibility-e2e-secret-at-least-32-chars';
const viewports=[
  {label:'320 portrait',width:320,height:568},{label:'320 landscape',width:568,height:320},
  {label:'375 portrait',width:375,height:667},{label:'375 landscape',width:667,height:375},
  {label:'768 portrait',width:768,height:1024},{label:'768 landscape',width:1024,height:768},
  {label:'1440 portrait',width:1440,height:1920},{label:'1440 landscape',width:1440,height:900},
];

const indexSource=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
const todayCss=await fs.readFile(new URL('../public/today.css',import.meta.url),'utf8');
assert.match(indexSource,/id="today-state"[^>]*aria-busy="true"[^>]*data-skeleton/u,'Today must expose its initial no-CLS skeleton');
assert.match(todayCss,/\.today-state\[data-skeleton\][^{]*\{[^}]*min-block-size\s*:/su,'Today skeleton must reserve block size');

let browser;
let child;
let temporaryDirectory;
try{
  temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'aisy-accessibility-e2e-'));
  const port=await availablePort();
  const baseUrl=`http://127.0.0.1:${port}`;
  const now=Date.now();
  const dataFile=path.join(temporaryDirectory,'data.json');
  await fs.writeFile(dataFile,JSON.stringify({
    users:{learner:{
      created:now,sub_until:now+86_400_000,
      privacy_consent:{
        text_processing:true,voice_processing:true,
        policy_version:'2026-08-02-voice-v1',updated_at:new Date(now).toISOString(),
      },
    }},progress:{learner:{}},
  }),'utf8');
  const output=[];
  child=spawn(process.execPath,[serverPath],{
    cwd:projectDirectory,
    env:createReleaseServerEnvironment({
      NODE_ENV:'test',PORT:String(port),APP_URL:baseUrl,
      DATABASE_PROVIDER:'file',DATA_FILE:dataFile,JWT_SECRET:jwtSecret,
      ADAPTIVE_LEARNING_ENABLED:'false',
    }),
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data',chunk=>output.push(chunk.toString()));
  child.stderr.on('data',chunk=>output.push(chunk.toString()));
  await waitForReady(baseUrl,child,output);
  browser=await chromium.launch({headless:true,executablePath:await chromeExecutable()});
  const harness=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'learner',jwtSecret,
    contextOptions:{viewport:{width:375,height:667},reducedMotion:'reduce'},
  });
  const {context,page}=harness;
  const {
    browserFailures,networkGuard,paidBoundaryCalls,
  }=await prepareReleaseBrowserBoundary(context,{
    applicationOrigin:baseUrl,
    allowedHttpResponses:[
      {method:'GET',path:'/api/v1/adaptive-learning/sessions/current',status:404},
      {method:'GET',path:'/api/v1/adaptive-learning/goal',status:404},
    ],
  });
  await page.goto(baseUrl,{waitUntil:'networkidle'});
  await page.locator('#scr1.on').waitFor({state:'visible',timeout:10_000});
  try{await page.locator('#today-ready:not([hidden])').waitFor({state:'visible',timeout:10_000})}
  catch(error){const state=await page.evaluate(()=>({cur:window.cur?.(),currentUser:window.currentUser,context:document.getElementById('today-context')?.textContent,state:document.getElementById('today-state-message')?.textContent,busy:document.getElementById('today-state')?.getAttribute('aria-busy')}));throw new Error(`Today did not settle: ${JSON.stringify(state)}\n${browserFailures.join('\n')}`,{cause:error})}
  const navigation=page.getByRole('navigation',{name:'Основные разделы'});
  await navigation.waitFor({state:'visible'});

  const semantics=await page.evaluate(()=>({
    navTag:document.getElementById('aisy-shell-nav')?.tagName,
    mainLabel:document.querySelector('#scr1.on main')?.getAttribute('aria-labelledby'),
    heading:document.querySelector('#scr1.on h1')?.id,
    politeStates:[...document.querySelectorAll('#scr1.on [role="status"][aria-live="polite"]')].length,
  }));
  assert.deepEqual(semantics,{navTag:'NAV',mainLabel:'today-title',heading:'today-title',politeStates:1});

  const destinations=[
    {name:'Практика',screen:'#aisy-practice.on',heading:'Практика'},
    {name:'ЕГЭ',screen:'#aisy-ege.on',heading:'ЕГЭ'},
    {name:'Прогресс',screen:'#scr10.on',heading:'Прогресс'},
    {name:'Профиль',screen:'#scr11.on',heading:'Профиль'},
    {name:'Сегодня',screen:'#scr1.on',heading:null},
  ];

  for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    for(const theme of ['light','dark']){
      await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
      await page.evaluate(value=>new Promise(resolve=>{
        window.AisyTheme.set(value);
        requestAnimationFrame(()=>requestAnimationFrame(resolve));
      }),theme);
      for(const destination of destinations){
        await navigation.getByRole('button',{name:destination.name,exact:true}).click();
        await page.locator(destination.screen).waitFor({state:'visible',timeout:8_000});
        const layout=await page.evaluate(screenSelector=>{
          const active=document.querySelector(screenSelector);
          const frame=document.getElementById('frame').getBoundingClientRect();
          const nav=document.getElementById('aisy-shell-nav').getBoundingClientRect();
          const navList=document.querySelector('.aisy-shell-nav__list');
          const controls=[...active.querySelectorAll('button,input,select,textarea,a[href]'),
            ...document.querySelectorAll('#aisy-shell-nav button,#asya-launcher')]
            .filter(control=>control.getClientRects().length&&!control.disabled).map(control=>{
              const rect=control.getBoundingClientRect();return{label:control.getAttribute('aria-label')||control.textContent?.trim()||control.id,width:rect.width,height:rect.height};
            });
          const heading=active.querySelector('h1');
          const labelledMain=active.matches('[role="main"][aria-labelledby]')
            ?active:active.querySelector('main[aria-labelledby],[role="main"][aria-labelledby]');
          const rootStyle=getComputedStyle(document.documentElement);
          const motion=getComputedStyle(document.getElementById('asya-launcher')).transitionDuration;
          return{
            viewport:document.documentElement.clientWidth,documentWidth:document.documentElement.scrollWidth,
            frameLeft:frame.left,frameRight:frame.right,frameWidth:frame.width,
            navLeft:nav.left,navRight:nav.right,navWidth:nav.width,
            navColumns:getComputedStyle(navList).gridTemplateColumns.split(' ').filter(Boolean).length,
            controls,motion,colorScheme:rootStyle.colorScheme,theme:document.documentElement.dataset.theme,
            headingId:heading?.id||'',headingText:heading?.textContent||'',
            mainLabel:labelledMain?.getAttribute('aria-labelledby')||'',
            liveStates:active.querySelectorAll('[role="status"][aria-live]').length,
          };
        },destination.screen);
        assert.ok(layout.documentWidth<=layout.viewport,`${destination.name} horizontal overflow at ${viewport.label}/${theme}`);
        assert.ok(layout.frameLeft>=-0.5&&layout.frameRight<=layout.viewport+0.5,`${destination.name} frame overflow at ${viewport.label}/${theme}`);
        assert.ok(layout.frameWidth<=390.5,`${destination.name} learner canvas exceeds the approved phone width at ${viewport.label}/${theme}`);
        assert.ok(Math.abs(layout.navLeft-layout.frameLeft)<=1&&Math.abs(layout.navRight-layout.frameRight)<=1,
          `${destination.name} bottom navigation must stay inside the phone at ${viewport.label}/${theme}`);
        assert.equal(layout.navColumns,5,`${destination.name} navigation became a side rail at ${viewport.label}/${theme}`);
        if(viewport.width>390){
          assert.ok(Math.abs(layout.frameLeft-(layout.viewport-layout.frameWidth)/2)<=1,
            `${destination.name} phone is not centered at ${viewport.label}/${theme}`);
        }
        assert.deepEqual(layout.controls.filter(control=>control.width<44||control.height<44),[],`${destination.name} touch target below 44px at ${viewport.label}/${theme}`);
        if(destination.heading)assert.match(layout.headingText,new RegExp(destination.heading,'u'));
        else assert.ok(layout.headingText.trim(),`${destination.name} must expose a non-empty h1`);
        assert.equal(layout.mainLabel,layout.headingId,`${destination.name} main must reference its h1 at ${viewport.label}/${theme}`);
        assert.ok(layout.liveStates>=1,`${destination.name} must expose an assistive live state at ${viewport.label}/${theme}`);
        assert.equal(await navigation.locator('[aria-current="page"]').count(),1);
        assert.ok(layout.motion==='0s'||Number.parseFloat(layout.motion)<=0.01,`reduced motion exceeds the existing 10ms accessibility contract at ${viewport.label}/${theme}`);
        assert.equal(layout.theme,theme,`theme attribute changed at ${viewport.label}`);
        assert.equal(layout.colorScheme,theme,`wrong ${theme} color scheme at ${viewport.label}: ${JSON.stringify(layout)}`);
      }
    }
  }

  await page.setViewportSize({width:375,height:667});
  await page.getByRole('button',{name:'Сегодня',exact:true}).focus();
  await page.keyboard.press('Tab');
  const focus=await page.getByRole('button',{name:'Практика',exact:true}).evaluate(element=>{
    const style=getComputedStyle(element);return{style:style.outlineStyle,width:Number.parseFloat(style.outlineWidth)};
  });
  assert.notEqual(focus.style,'none','keyboard focus must be visible');
  assert.ok(focus.width>=3,'keyboard focus ring must be at least 3px');

  const asyaLauncher=page.locator('#asya-launcher');
  const asyaDialog=page.locator('#asya-assistant');
  for(let cycle=1;cycle<=2;cycle+=1){
    await asyaLauncher.focus();
    await asyaLauncher.click();
    await asyaDialog.waitFor({state:'visible',timeout:5_000});
    await asyaDialog.getByRole('button',{name:'Завершить разговор с Асей',exact:true}).click();
    await asyaDialog.waitFor({state:'hidden',timeout:5_000});
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'asya-launcher',`Asya must restore launcher focus after open/close cycle ${cycle}`);
  }

  const privacyDialog=page.locator('#privacySheet.open');
  if(await privacyDialog.isVisible()){
    assert.equal(await privacyDialog.getAttribute('role'),'dialog');
    assert.equal(await privacyDialog.getAttribute('aria-modal'),'true');
    await privacyDialog.getByRole('button',{name:'Позже',exact:true}).click();
  }

  await navigation.getByRole('button',{name:'Профиль',exact:true}).click();
  await page.locator('#scr11.on').waitFor({state:'visible',timeout:8_000});
  await page.locator('#privacyProfileButton').click();
  await privacyDialog.waitFor({state:'visible',timeout:5_000});
  assert.equal(await privacyDialog.locator('#privacyText').isChecked(),true,'persisted text consent must render checked');
  assert.equal(await privacyDialog.locator('#privacyVoice').isChecked(),true,'persisted voice consent must render checked');
  await privacyDialog.getByRole('button',{name:'Сохранить выбор',exact:true}).click();
  await privacyDialog.waitFor({state:'hidden',timeout:5_000});
  const persistedConsent=await context.request.get(`${baseUrl}/api/v1/privacy/consent`,{
    headers:{'X-EasyBoost-Expected-Owner':'learner'},
  });
  assert.equal(persistedConsent.status(),200);
  const persistedConsentBody=await persistedConsent.json();
  assert.equal(persistedConsentBody.text_processing,true,'saving an unchanged dialog must preserve text consent');
  assert.equal(persistedConsentBody.voice_processing,true,'saving an unchanged dialog must preserve voice consent');

  assert.deepEqual(browserFailures,[],'online accessibility matrix must not hide browser failures');
  assert.deepEqual(networkGuard.failures,[],'online accessibility matrix must not hide network failures');
  assert.deepEqual(paidBoundaryCalls,[],'accessibility gate must not cross a paid-provider boundary');
  browserFailures.length=0;

  try{await page.waitForFunction(async()=>{await navigator.serviceWorker.ready;return Boolean(navigator.serviceWorker.controller)},null,{timeout:15_000})}
  catch(error){throw new Error(`Service worker did not control the page:\n${browserFailures.join('\n')}`,{cause:error})}
  networkGuard.setOffline(true);
  await context.setOffline(true);
  assert.equal(await page.evaluate(()=>navigator.onLine),false);
  await page.getByRole('navigation',{name:'Основные разделы'}).getByRole('button',{name:'Практика',exact:true}).click();
  await page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:8_000});
  await page.locator('#practice-network-state:not([hidden])').waitFor({state:'visible',timeout:5_000});
  assert.match(await page.locator('#practice-network-state').textContent(),/нет сети/u);
  assert.match(await page.locator('.practice-row[data-skill="vocabulary"] .practice-row__availability').textContent(),/доступны офлайн/u);
  assert.match(await page.locator('.practice-row[data-skill="writing"] .practice-row__availability').textContent(),/требует подключени|требует сеть/u);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('#access_gate[data-state="network-unknown"]').waitFor({state:'visible',timeout:10_000});
  assert.equal(await page.locator('#scr1.on').count(),0,'offline reload must not claim unverified learning access');
  assert.match(await page.locator('#access_gate_copy').textContent(),/нет связи с сервером|Проверьте сеть/u);
  assert.deepEqual(browserFailures,[],'offline accessibility checks must not hide page failures');
  assert.deepEqual(networkGuard.failures,[],'offline accessibility checks must not hide app errors');
  assert.deepEqual(paidBoundaryCalls,[],'offline accessibility checks must not cross provider boundaries');

  await context.close();
  console.log('Aisy accessibility, responsive themes and offline truth Chromium E2E passed.');
}finally{
  if(browser)await browser.close();
  await stopProcess(child);
  if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
