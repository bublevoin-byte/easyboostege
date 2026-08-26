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

const projectDirectory=fileURLToPath(new URL('..',import.meta.url));
const serverPath=fileURLToPath(new URL('../server.js',import.meta.url));
const jwtSecret='aisy-practice-e2e-secret-at-least-32-chars';
const expectedSkills=['Слова','Грамматика','Чтение','Аудирование','Письмо','Говорение'];

async function openPractice(page){
  await page.getByRole('navigation',{name:'Основные разделы'}).getByRole('button',{name:'Практика'}).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:5_000});
  await page.locator('#practice-skills .practice-row').first().waitFor({state:'visible',timeout:5_000});
}

let browser;
let child;
let temporaryDirectory;
try{
  temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'aisy-practice-e2e-'));
  const port=await availablePort();
  const baseUrl=`http://127.0.0.1:${port}`;
  const now=Date.now();
  const dataFile=path.join(temporaryDirectory,'data.json');
  await fs.writeFile(dataFile,JSON.stringify({
    users:{learner:{
      created:now,sub_until:now+86_400_000,
      privacy_consent:{
        text_processing:true,voice_processing:false,
        policy_version:'2026-08-26-vk-id-v1',updated_at:new Date(now).toISOString(),
      },
    }},
    progress:{learner:{}},
  }),'utf8');
  const output=[];
  child=spawn(process.execPath,[serverPath],{
    cwd:projectDirectory,
    env:{
      ...process.env,NODE_ENV:'test',PORT:String(port),APP_URL:baseUrl,
      DATABASE_PROVIDER:'file',DATA_FILE:dataFile,JWT_SECRET:jwtSecret,
      TELEGRAM_BOT_TOKEN:'',ADMIN_TELEGRAM_ID:'',XAI_ENABLED:'false',
      VOICE_TUTOR_ENABLED:'false',ADAPTIVE_LEARNING_ENABLED:'false',
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data',chunk=>output.push(chunk.toString()));
  child.stderr.on('data',chunk=>output.push(chunk.toString()));
  await waitForReady(baseUrl,child,output);
  browser=await chromium.launch({headless:true,executablePath:await chromeExecutable()});

  const mobile=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'learner',jwtSecret,
    contextOptions:{viewport:{width:320,height:720},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  const browserErrors=[];
  mobile.page.on('pageerror',error=>browserErrors.push(error.message));
  await mobile.page.goto(baseUrl,{waitUntil:'networkidle'});
  await mobile.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  await openPractice(mobile.page);

  const rows=mobile.page.locator('#practice-skills .practice-row');
  assert.equal(await rows.count(),6);
  assert.deepEqual(await rows.locator('h2').allTextContents(),expectedSkills);
  assert.equal(await rows.locator('button').count(),6,'each skill row must expose exactly one action');
  assert.equal(await rows.locator('.aisy-button:not(.aisy-button--secondary)').count(),0,'skill rows stay secondary');
  assert.equal(await mobile.page.locator('#practice-recommendation .aisy-button:not(.aisy-button--secondary)').count(),1,
    'Practice must expose exactly one projected primary action');
  assert.equal(await rows.locator('svg[stroke="currentColor"][stroke-width="2"]').count(),6);
  assert.equal(await rows.evaluateAll(items=>items.every(item=>item.querySelectorAll('button').length===1)),true);

  for(const viewport of [{width:320,height:720},{width:375,height:667},{width:768,height:1024}]){
    await mobile.page.setViewportSize(viewport);
    const layout=await mobile.page.evaluate(()=>({
      viewport:innerWidth,
      documentWidth:document.documentElement.scrollWidth,
      controls:[...document.querySelectorAll('#practice-skills button')].map(button=>{
        const rect=button.getBoundingClientRect();return{width:rect.width,height:rect.height};
      }),
    }));
    assert.ok(layout.documentWidth<=layout.viewport,`Practice must not overflow at ${viewport.width}px`);
    assert.equal(layout.controls.every(control=>control.width>=44&&control.height>=44),true);
  }

  const vocabulary=rows.filter({has:mobile.page.getByRole('heading',{name:'Слова',exact:true})});
  await vocabulary.getByRole('button',{name:'Открыть: Слова'}).press('Enter');
  await mobile.page.locator('#scr2.on').waitFor({state:'visible',timeout:5_000});
  assert.deepEqual(await mobile.page.evaluate(()=>({
    back:[...document.querySelectorAll('#aisy-shell-back:not([hidden])')].map(button=>button.getAttribute('aria-label')),
    navHidden:document.getElementById('aisy-shell-nav').hidden,
    navInert:document.getElementById('aisy-shell-nav').inert,
  })),{back:['Назад в раздел Практика'],navHidden:true,navInert:true});
  assert.equal(await mobile.page.evaluate(()=>document.activeElement?.closest('#scr2')!==null),true);
  await mobile.page.getByRole('button',{name:/^Начать ·/u}).press('Enter');
  await mobile.page.locator('#scr2 .vocab-practice-card').waitFor({state:'visible',timeout:5_000});
  const wordProgress=await mobile.page.evaluate(()=>({
    index:window.WI,
    length:window.WQ?.length,
    word:window.WQ?.[window.WI]?.word,
    attemptId:document.getElementById('w_area').dataset.sessionAttemptId,
    phase:document.getElementById('w_area').dataset.sessionPhase,
  }));
  assert.ok(wordProgress.length>0);
  assert.match(wordProgress.attemptId,/^[0-9a-f-]{36}$/u);
  assert.equal(wordProgress.phase,'task');

  for(const viewport of [{width:320,height:720},{width:720,height:320}]){
    await mobile.page.setViewportSize(viewport);
    const layout=await mobile.page.evaluate(()=>{
      const screen=document.getElementById('scr2').getBoundingClientRect();
      const frame=document.getElementById('frame').getBoundingClientRect();
      const route=document.querySelector('#scr2 .words-route').getBoundingClientRect();
      const area=document.getElementById('w_area');
      const areaRect=area.getBoundingClientRect();
      const dock=document.getElementById('w_action_dock').getBoundingClientRect();
      const primary=document.querySelector('#w_action_dock .aisy-button');
      const cta=primary.getBoundingClientRect();
      const affordance=getComputedStyle(primary,'::after');
      const frameStyle=getComputedStyle(document.getElementById('frame'));
      const routeStyle=getComputedStyle(document.querySelector('#scr2 .words-route'));
      const dockStyle=getComputedStyle(document.getElementById('w_action_dock'));
      const controls=[...document.querySelectorAll('#scr2 button')].filter(button=>button.getClientRects().length)
        .map(button=>{const rect=button.getBoundingClientRect();return{width:rect.width,height:rect.height}});
      return{
        viewportWidth:innerWidth,viewportHeight:innerHeight,documentWidth:document.documentElement.scrollWidth,
        frameWidth:frame.width,frameHeight:frame.height,screenTop:screen.top,screenHeight:screen.height,
        routeTop:route.top,routeBottom:route.bottom,routeHeight:route.height,
        areaHeight:areaRect.height,areaBottom:areaRect.bottom,dockTop:dock.top,dockBottom:dock.bottom,
        screenBottom:screen.bottom,ctaHeight:cta.height,affordanceWidth:affordance.width,
        affordanceHeight:affordance.height,controls,
        computed:{frameHeight:frameStyle.height,frameBlockSize:frameStyle.blockSize,
          routeDisplay:routeStyle.display,routeRows:routeStyle.gridTemplateRows,
          dockDisplay:dockStyle.display,dockHeight:dockStyle.height,dockBlockSize:dockStyle.blockSize,
          dockPadding:dockStyle.padding,dockMinHeight:dockStyle.minHeight},
      };
    });
    assert.ok(layout.documentWidth<=layout.viewportWidth,`Words must not overflow at ${viewport.width}×${viewport.height}`);
    assert.ok(layout.frameWidth<=390.5,'Words remains a centered phone canvas without a side rail');
    assert.ok(layout.areaHeight>0,'the scrollable answer area must not collapse');
    assert.ok(layout.areaBottom<=layout.dockTop+1,'the action dock must not cover the answer area');
    assert.ok(layout.dockBottom<=layout.screenBottom+1,
      `the dock must stay inside the deep screen: ${JSON.stringify(layout)}`);
    assert.equal(Math.round(layout.ctaHeight),58);
    assert.equal(Math.round(Number.parseFloat(layout.affordanceWidth)),38);
    assert.equal(Math.round(Number.parseFloat(layout.affordanceHeight)),38);
    assert.equal(layout.controls.every(control=>control.width>=44&&control.height>=44),true,
      'every visible Words control keeps a 44×44 touch target');
  }
  await mobile.page.setViewportSize({width:320,height:720});

  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await mobile.page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:5_000});
  const continuingVocabulary=mobile.page.locator('.practice-row[data-skill="vocabulary"][data-state="continue"]');
  await continuingVocabulary.waitFor({state:'visible',timeout:5_000});
  await continuingVocabulary.getByRole('button',{name:'Продолжить: Слова'}).press('Enter');
  await mobile.page.locator('#scr2.on .vocab-practice-card').waitFor({state:'visible',timeout:5_000});
  assert.deepEqual(await mobile.page.evaluate(()=>({
    index:window.WI,
    length:window.WQ?.length,
    word:window.WQ?.[window.WI]?.word,
    attemptId:document.getElementById('w_area').dataset.sessionAttemptId,
    phase:document.getElementById('w_area').dataset.sessionPhase,
  })),wordProgress,'Practice must reopen the active vocabulary card without resetting it');

  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  const reading=mobile.page.locator('.practice-row[data-skill="reading"]');
  await reading.getByRole('button',{name:'Открыть: Чтение'}).press('Enter');
  await mobile.page.locator('#scr7.on .reading-hub').waitFor({state:'visible',timeout:5_000});
  await mobile.page.getByRole('button',{name:'Начать Task 12–18'}).press('Enter');
  await mobile.page.locator('#scr7.on .reading-practice').waitFor({state:'visible',timeout:5_000});
  const firstReadingAnswer=mobile.page.locator('#scr7 [data-reading-answer]').first();
  await firstReadingAnswer.press('Space');
  const readingProgress=await mobile.page.locator('#scr7 [data-reading-answer]').evaluateAll(fields=>fields.map(field=>({value:field.value,checked:field.checked})));
  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  const continuingReading=mobile.page.locator('.practice-row[data-skill="reading"][data-state="continue"]');
  await continuingReading.waitFor({state:'visible',timeout:5_000});
  await continuingReading.getByRole('button',{name:'Продолжить: Чтение'}).press('Enter');
  await mobile.page.locator('#scr7.on .reading-practice').waitFor({state:'visible',timeout:5_000});
  assert.deepEqual(
    await mobile.page.locator('#scr7 [data-reading-answer]').evaluateAll(fields=>fields.map(field=>({value:field.value,checked:field.checked}))),
    readingProgress,
    'Practice must reopen the active reading set without resetting its answers',
  );

  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  const writing=mobile.page.locator('.practice-row[data-skill="writing"]');
  await writing.getByRole('button',{name:'Открыть: Письмо'}).press('Enter');
  await mobile.page.locator('#scr8.on').waitFor({state:'visible',timeout:5_000});
  const editor=mobile.page.locator('#w_editor');
  await editor.waitFor({state:'visible',timeout:5_000});
  const savedDraft='Dear Ben,\nThank you for your message. This is my saved draft.';
  await editor.fill(savedDraft);
  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  const continuingWriting=mobile.page.locator('.practice-row[data-skill="writing"][data-state="continue"]');
  await continuingWriting.waitFor({state:'visible',timeout:5_000});
  await continuingWriting.getByRole('button',{name:'Продолжить: Письмо'}).press('Enter');
  await mobile.page.locator('#scr8.on #w_editor').waitFor({state:'visible',timeout:5_000});
  assert.equal(await mobile.page.locator('#w_editor').innerText(),savedDraft);

  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  const listeningRow=mobile.page.locator('.practice-row[data-skill="listening"]');
  await listeningRow.getByRole('button',{name:/Аудирование$/u}).press('Enter');
  await mobile.page.locator('#scr4.on').waitFor({state:'visible',timeout:5_000});
  await mobile.page.locator('#scr4.on .listening-launch-grid').waitFor({state:'visible',timeout:8_000});
  const listeningPrimary=mobile.page.locator('#l_action_dock .learning-primary');
  await listeningPrimary.waitFor({state:'visible',timeout:8_000});
  assert.match(await listeningPrimary.innerText(),/Полный раздел 1–9/u);
  await listeningPrimary.press('Enter');
  assert.equal(await listeningPrimary.innerText(),'Начать полный раздел');
  await listeningPrimary.press('Enter');
  const firstListeningAnswer=mobile.page.getByRole('radio',{name:'Говорящий A, утверждение 1'});
  await firstListeningAnswer.press('Enter');
  const listeningProgress=await mobile.page.evaluate(()=>({stage:window.LE?.stage,selections:window.LE?.selM?.slice(),startedAt:window.LE?.t0}));
  assert.equal(listeningProgress.selections[0]!==null,true);
  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  const continuingListening=mobile.page.locator('.practice-row[data-skill="listening"][data-state="continue"]');
  await continuingListening.waitFor({state:'visible',timeout:5_000});
  await mobile.page.waitForTimeout(300);
  await continuingListening.getByRole('button',{name:'Продолжить: Аудирование'}).press('Enter');
  await mobile.page.getByRole('radio',{name:'Говорящий A, утверждение 1'}).waitFor({state:'visible',timeout:5_000});
  const resumedListening=await mobile.page.evaluate(()=>({
    stage:window.LE?.stage,selections:window.LE?.selM?.slice(),startedAt:window.LE?.t0,
    pausedAt:window.LE?.pausedAt,interval:window.LE?.iv,
  }));
  assert.deepEqual(
    {stage:resumedListening.stage,selections:resumedListening.selections},
    {stage:listeningProgress.stage,selections:listeningProgress.selections},
    'Practice must resume the paused listening exam without resetting its answers',
  );
  assert.ok(resumedListening.startedAt>listeningProgress.startedAt+150,'paused hub time must be excluded from the exam timer');
  assert.equal(resumedListening.pausedAt,null);
  assert.equal(resumedListening.interval!=null,true);

  await mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await mobile.context.setOffline(true);
  await mobile.page.locator('#practice-network-state:not([hidden])').waitFor({state:'visible',timeout:5_000});
  assert.equal(await mobile.page.locator('.practice-row[data-skill="vocabulary"]').getAttribute('data-availability'),'offline-ready');
  assert.equal(await mobile.page.locator('.practice-row[data-skill="writing"]').getAttribute('data-availability'),'cached');
  const listening=mobile.page.locator('.practice-row[data-skill="listening"]');
  await listening.waitFor({state:'visible',timeout:5_000});
  assert.match(await listening.locator('.practice-row__availability').textContent(),/загружен|доступ/u);
  await mobile.context.setOffline(false);
  const authorityCleanup=await mobile.page.evaluate(async()=>{
    const marker=window.EasyBoostStore.readCurrentOwner();
    const active={words:window.WQ?.length||0,reading:Boolean(window.RQ),listening:Boolean(window.LE)};
    await window.EasyBoostAuthority.invalidate(marker);
    return{
      active,
      cleared:{words:window.WQ?.length||0,reading:Boolean(window.RQ),listening:Boolean(window.LE)},
    };
  });
  assert.equal(authorityCleanup.active.words>0,true);
  assert.deepEqual(authorityCleanup.active,{words:authorityCleanup.active.words,reading:true,listening:true});
  assert.deepEqual(authorityCleanup.cleared,{words:0,reading:false,listening:false},'authority reset must clear every subject transient');
  assert.deepEqual(browserErrors,[]);
  await mobile.context.close();

  const desktop=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'learner',jwtSecret,
    contextOptions:{viewport:{width:1440,height:900},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  await desktop.page.goto(baseUrl,{waitUntil:'networkidle'});
  await desktop.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  await openPractice(desktop.page);
  const desktopLayout=await desktop.page.evaluate(()=>{
    const frame=document.getElementById('frame').getBoundingClientRect();
    return{
      viewport:innerWidth,
      documentWidth:document.documentElement.scrollWidth,
      frameWidth:frame.width,
      controls:[...document.querySelectorAll('#practice-skills button')].map(button=>{
        const rect=button.getBoundingClientRect();return{width:rect.width,height:rect.height};
      }),
    };
  });
  assert.ok(desktopLayout.documentWidth<=desktopLayout.viewport);
  assert.ok(desktopLayout.frameWidth<=720);
  assert.equal(desktopLayout.controls.every(control=>control.width>=44&&control.height>=44),true);
  await desktop.context.close();

  const offlineFirst=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'learner',jwtSecret,
    contextOptions:{viewport:{width:375,height:667},reducedMotion:'reduce'},
  });
  const offlineFirstErrors=[];
  offlineFirst.page.on('pageerror',error=>offlineFirstErrors.push(`page: ${error.message}`));
  offlineFirst.page.on('requestfailed',request=>offlineFirstErrors.push(`request: ${request.url()} ${request.failure()?.errorText||''}`));
  await offlineFirst.page.goto(baseUrl,{waitUntil:'networkidle'});
  await offlineFirst.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  await offlineFirst.page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
  if(!await offlineFirst.page.evaluate(()=>Boolean(navigator.serviceWorker.controller))){
    await offlineFirst.page.reload({waitUntil:'networkidle'});
    await offlineFirst.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  }
  await offlineFirst.page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller),null,{timeout:10_000});
  assert.equal(await offlineFirst.page.locator('#aisy-practice.on').count(),0,'offline contour must not warm Practice by opening it online');
  await offlineFirst.context.setOffline(true);
  await openPractice(offlineFirst.page);
  assert.deepEqual(offlineFirstErrors,[],'Practice install-cache must resolve its transitive module graph offline');
  assert.equal(await offlineFirst.page.locator('#practice-skills .practice-row').count(),6);
  await offlineFirst.page.locator('#practice-network-state:not([hidden])').waitFor({state:'visible',timeout:5_000});
  await offlineFirst.context.setOffline(false);
  await offlineFirst.context.close();
  console.log('Aisy Practice Chromium E2E passed.');
}finally{
  if(browser)await browser.close();
  await stopProcess(child);
  if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
