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
const jwtSecret='aisy-today-e2e-secret-at-least-32-chars';

async function browserApiRequest(page,requestPath,{method='GET',key='',body=null}={}){
  return page.evaluate(async({pathName,requestMethod,idempotencyKey,payload})=>{
    const marker=window.EasyBoostStore.readCurrentOwner();
    const headers={'X-EasyBoost-Expected-Owner':marker.owner};
    if(payload!==null)headers['Content-Type']='application/json';
    if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
    const response=await fetch(pathName,{
      method:requestMethod,credentials:'same-origin',headers,
      ...(payload===null?{}:{body:JSON.stringify(payload)}),
    });
    return{status:response.status,body:await response.json()};
  },{pathName:requestPath,requestMethod:method,idempotencyKey:key,payload:body});
}

async function prepareAdaptivePlan(page){
  let state=(await browserApiRequest(page,'/api/v1/adaptive-learning/diagnostics/start',{
    method:'POST',key:'aisy-today-browser-diagnostic-start',body:{depth:'short'},
  })).body;
  let answerIndex=0;
  while(state.diagnostic.status==='in_progress'){
    answerIndex+=1;
    const response=await browserApiRequest(page,`/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/answers`,{
      method:'POST',key:`aisy-today-browser-diagnostic-answer-${answerIndex}`,
      body:{itemId:state.item.id,choiceId:state.item.choices[0].id},
    });
    assert.equal(response.status,201);
    state=response.body;
  }
  const completed=await browserApiRequest(page,`/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/complete`,{
    method:'POST',key:'aisy-today-browser-diagnostic-complete',body:{},
  });
  assert.equal(completed.status,201);
  const goal=await browserApiRequest(page,'/api/v1/adaptive-learning/goal',{
    method:'PUT',key:'aisy-today-browser-goal',
    body:{targetExam:'ege_english',targetScore:75,examDate:'2027-06-01',weeklyMinutes:300},
  });
  assert.equal(goal.status,201);
}

let browser;
let child;
let temporaryDirectory;
try{
  temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'aisy-today-e2e-'));
  const port=await availablePort();
  const baseUrl=`http://127.0.0.1:${port}`;
  const now=Date.now();
  const dataFile=path.join(temporaryDirectory,'data.json');
  await fs.writeFile(dataFile,JSON.stringify({
    users:{
      learner:{created:now,sub_until:now+86_400_000},
      planner:{created:now,sub_until:now+86_400_000},
      timeout:{created:now,sub_until:now+86_400_000},
    },
    progress:{learner:{dayMin:12,streak:4},planner:{dayMin:0,streak:0},timeout:{dayMin:0,streak:0}},
  }),'utf8');
  const output=[];
  child=spawn(process.execPath,[serverPath],{
    cwd:projectDirectory,
    env:{
      ...process.env,NODE_ENV:'test',PORT:String(port),APP_URL:baseUrl,
      DATABASE_PROVIDER:'file',DATA_FILE:dataFile,JWT_SECRET:jwtSecret,
      TELEGRAM_BOT_TOKEN:'',ADMIN_TELEGRAM_ID:'',XAI_ENABLED:'false',
      VOICE_TUTOR_ENABLED:'false',ADAPTIVE_LEARNING_ENABLED:'true',
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data',chunk=>output.push(chunk.toString()));
  child.stderr.on('data',chunk=>output.push(chunk.toString()));
  await waitForReady(baseUrl,child,output);
  browser=await chromium.launch({headless:true,executablePath:await chromeExecutable()});
  const mobile=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'learner',jwtSecret,
    contextOptions:{viewport:{width:320,height:568},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  const browserErrors=[];
  const adaptiveSessionRequests=[];
  mobile.page.on('pageerror',error=>browserErrors.push(error.message));
  mobile.page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/v1/adaptive-learning/sessions'))adaptiveSessionRequests.push(request.url())});

  await mobile.page.goto(baseUrl,{waitUntil:'networkidle'});
  await mobile.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  await mobile.page.getByRole('heading',{name:/Здравствуйте, learner/u}).waitFor({state:'visible',timeout:5_000}).catch(error=>{
    return mobile.page.evaluate(()=>({
      title:document.getElementById('today-title')?.textContent,
      state:document.getElementById('today-state-title')?.textContent,
      ready:document.getElementById('today-ready')?.hidden,
      moduleScripts:[...document.scripts].map(script=>script.src),
    })).then(snapshot=>{throw new Error(error.message+'\nBrowser errors: '+JSON.stringify(browserErrors)+'\nSnapshot: '+JSON.stringify(snapshot))});
  });
  const recommendation=mobile.page.getByRole('region',{name:'Рекомендация на сегодня'});
  await recommendation.waitFor({state:'visible',timeout:5_000});
  assert.equal(await mobile.page.locator('#scr1 .clayCard').count(),0,'Today must not expose the old six-module grid');

  const choices=recommendation.getByRole('radio');
  assert.deepEqual(await choices.allTextContents(),['10 минут','20 минут','30 минут','40 минут']);
  await choices.filter({hasText:'20 минут'}).press('Space');
  const diagnostic=mobile.page.locator('#today-diagnostic[data-state="recommended"]');
  await diagnostic.waitFor({state:'visible',timeout:5_000});
  await mobile.page.setViewportSize({width:375,height:667});
  const diagnosticLayout=await diagnostic.evaluate(node=>({
    cardWidth:node.clientWidth,contentWidth:node.scrollWidth,
    pageWidth:document.documentElement.clientWidth,pageContentWidth:document.documentElement.scrollWidth,
  }));
  assert.equal(diagnosticLayout.contentWidth<=diagnosticLayout.cardWidth,true,'diagnostic card must not overflow at 375px');
  assert.equal(diagnosticLayout.pageContentWidth<=diagnosticLayout.pageWidth,true,'Today must not overflow the 375px viewport');
  await diagnostic.getByRole('button',{name:'Отложить на сейчас'}).press('Enter');
  await mobile.page.locator('#today-diagnostic[data-state="deferred"]').waitFor({state:'visible',timeout:5_000});
  assert.match(await mobile.page.locator('#today-diagnostic-copy').textContent(),/это не оценка/u);
  await mobile.page.reload({waitUntil:'networkidle'});
  await mobile.page.locator('#today-diagnostic[data-state="deferred"]').waitFor({state:'visible',timeout:5_000});
  const twenty=choices.filter({hasText:'20 минут'});
  await twenty.waitFor({state:'visible',timeout:5_000});
  assert.equal(await twenty.getAttribute('aria-checked'),'true','a valid adaptive preference must survive reload');
  await twenty.focus();
  await twenty.press('ArrowRight');
  const thirty=choices.filter({hasText:'30 минут'});
  assert.equal(await thirty.getAttribute('aria-checked'),'true');
  assert.equal(await thirty.evaluate(node=>document.activeElement===node),true);
  await mobile.page.waitForTimeout(750);
  await choices.filter({hasText:'10 минут'}).press('Space');
  await mobile.page.reload({waitUntil:'networkidle'});
  await mobile.page.locator('#today-diagnostic[data-state="deferred"]').waitFor({state:'visible',timeout:5_000});
  assert.equal(await recommendation.locator('[role="radio"][aria-checked="true"]').textContent(),'30 минут','ten-minute practice must not overwrite an adaptive duration preference');
  await choices.filter({hasText:'10 минут'}).press('Space');
  const primary=recommendation.getByRole('button',{name:'Начать практику'});
  await primary.waitFor({state:'visible',timeout:5_000});
  const primaryBox=await primary.boundingBox();
  assert.ok(primaryBox.width>=44&&primaryBox.height>=44);
  assert.match(await mobile.page.locator('#today-recommendation-outcome').textContent(),/план|ритм/iu);
  const controlSizes=await recommendation.locator('button').evaluateAll(buttons=>buttons.map(button=>{
    const box=button.getBoundingClientRect();return{width:box.width,height:box.height};
  }));
  assert.equal(controlSizes.every(control=>control.width>=44&&control.height>=44),true);
  assert.equal(await mobile.page.locator('#today-duration-help').textContent(),'Быстрая практика на 10 минут не меняет обычную длительность занятия.');

  await primary.press('Enter');
  await mobile.page.locator('#scr2.on').waitFor({state:'visible',timeout:5_000});
  assert.deepEqual(adaptiveSessionRequests,[],'ten-minute practice must not call the 15–120 minute adaptive API');
  assert.equal(
    await mobile.page.evaluate(()=>document.activeElement?.id==='w_back'||document.activeElement?.closest('#scr2')!==null),
    true,
    'quick practice must open the existing vocabulary route',
  );
  await mobile.context.close();

  const planner=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'planner',jwtSecret,
    contextOptions:{viewport:{width:1024,height:768},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  const plannerSessionRequests=[];
  planner.page.on('request',request=>{
    const url=new URL(request.url());
    if(request.method()==='POST'&&url.pathname==='/api/v1/adaptive-learning/sessions'){
      plannerSessionRequests.push(JSON.parse(request.postData()||'{}'));
    }
  });
  await planner.page.goto(baseUrl,{waitUntil:'networkidle'});
  await planner.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  await prepareAdaptivePlan(planner.page);
  await planner.page.reload({waitUntil:'networkidle'});
  const plannerRecommendation=planner.page.getByRole('region',{name:'Рекомендация на сегодня'});
  await plannerRecommendation.waitFor({state:'visible',timeout:5_000});
  await plannerRecommendation.getByRole('radio',{name:'20 минут'}).press('Space');
  const previewResponse=planner.page.waitForResponse(response=>response.request().method()==='POST'
    &&new URL(response.url()).pathname==='/api/v1/adaptive-learning/sessions/preview');
  const createResponse=planner.page.waitForResponse(response=>response.request().method()==='POST'
    &&new URL(response.url()).pathname==='/api/v1/adaptive-learning/sessions');
  await plannerRecommendation.getByRole('button',{name:'Начать занятие'}).press('Enter');
  assert.equal((await previewResponse).status(),200);
  assert.equal((await createResponse).status(),201);
  assert.equal(plannerSessionRequests.length,1);
  assert.equal(plannerSessionRequests[0].durationMinutes,20);
  assert.match(plannerSessionRequests[0].previewFingerprint,/^[a-f0-9]{64}$/u);
  await planner.page.waitForFunction(()=>!document.getElementById('scr1')?.classList.contains('on'));
  await planner.page.evaluate(()=>window.tab('scr1'));
  await planner.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  const continueButton=plannerRecommendation.getByRole('button',{name:'Продолжить занятие'});
  await continueButton.waitFor({state:'visible',timeout:5_000});
  await continueButton.press('Enter');
  await planner.page.waitForFunction(()=>!document.getElementById('scr1')?.classList.contains('on'));
  assert.equal(plannerSessionRequests.length,1,'continue must not create another adaptive session');
  await planner.context.close();

  const timeoutHarness=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'timeout',jwtSecret,
    contextOptions:{viewport:{width:1024,height:768},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  let overviewAttempts=0;
  await timeoutHarness.page.route('**/api/v1/adaptive-learning/overview',async route=>{
    overviewAttempts+=1;
    if(overviewAttempts===1){
      setTimeout(()=>route.continue().catch(()=>{}),12_000);
      return;
    }
    await route.continue();
  });
  await timeoutHarness.page.goto(baseUrl,{waitUntil:'domcontentloaded'});
  await timeoutHarness.page.getByText('Собираем план на сегодня',{exact:true}).waitFor({state:'visible',timeout:5_000});
  const retry=timeoutHarness.page.getByRole('button',{name:'Повторить'});
  await retry.waitFor({state:'visible',timeout:11_000});
  assert.match(await timeoutHarness.page.locator('#today-state-title').textContent(),/не удалось загрузить/iu);
  await retry.press('Enter');
  await timeoutHarness.page.getByRole('region',{name:'Рекомендация на сегодня'}).waitFor({state:'visible',timeout:5_000});
  assert.equal(overviewAttempts,2,'retry must start one fresh bounded load');
  await timeoutHarness.context.close();
  console.log('Aisy Today Chromium E2E passed.');
}finally{
  if(browser)await browser.close();
  await stopProcess(child);
  if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
