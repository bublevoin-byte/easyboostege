import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import jwt from 'jsonwebtoken';
import {chromium} from 'playwright';
import {
  availablePort,chromeExecutable,createActiveSubscriptionPage,stopProcess,waitForReady,
} from './browser-server-harness.js';

const projectDirectory=fileURLToPath(new URL('..',import.meta.url));
const serverPath=fileURLToPath(new URL('../server.js',import.meta.url));
const jwtSecret='aisy-writing-paper-e2e-secret-32-chars';
const viewports=[
  {width:320,height:720,label:'320×720'},
  {width:375,height:812,label:'375×812'},
  {width:375,height:400,label:'375×400 keyboard viewport'},
  {width:720,height:320,label:'720×320'},
  {width:1440,height:900,label:'desktop phone canvas'},
];

const aiWarning='Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';
const simulatedWorks=new Map();
let simulatedTimestamp=1;

function successBody({verdict='Разбор готов',long=false,attemptId=701}={}){
  const baseErrors=[
    {kind:'err',title:'Грамматика · артикль',wrong:'go to the school',right:'go to school',note:'После go to перед school артикль здесь не нужен.',example:'For example: My brother goes to school by bus.'},
    {kind:'warn',title:'Связность',wrong:'This trend cause a problem.',right:'This trend causes a problem.',note:'Добавь явный переход и согласуй сказуемое с подлежащим.',example:'For example: However, this trend can cause a problem.'},
  ];
  const errors=long?Array.from({length:5},(_,index)=>({
    kind:index%3===0?'warn':'err',title:`Комментарий ${index+1}`,
    wrong:`A very long evidence fragment ${index+1} `.repeat(4),right:`Corrected fragment ${index+1}`,
    note:`Правило и объяснение ${index+1}. `.repeat(12),example:`Separate teaching example ${index+1}.`,
  })):baseErrors;
  const review={
      overall_got:11,overall_max:14,words:205,in_range:true,verdict,sub:'Серверный разбор по критериям.',
      criteria:[
        {name:'Решение коммуникативной задачи',got:2,max:3},
        {name:'Организация текста',got:2,max:3},
        {name:'Лексика',got:3,max:3},
        {name:'Грамматика',got:2,max:3},
        {name:'Орфография и пунктуация',got:2,max:2},
      ],errors,
  };
  if(!simulatedWorks.has(attemptId))simulatedWorks.set(attemptId,{
    attemptId,t:38,taskId:'builtin:writing_38:teen-sport',g:review.overall_got,m:review.overall_max,
    n:review.words,ts:simulatedTimestamp++,
  });
  const works=[...simulatedWorks.values()].slice(-30),recent=works.slice(-5);
  const average=Math.round(recent.reduce((total,work)=>total+work.g/work.m,0)/recent.length*100);
  return{
    contractVersion:'writing-evaluation-response-v1',review,
    provider:'test',attemptId,
    voiceTutor:{source:'writing',attemptId,revision:1,criterionChoices:[
      {index:0,label:'Решение коммуникативной задачи'},
      {index:1,label:'Организация текста'},
      {index:3,label:'Грамматика'},
    ]},
    assessment:{mode:'experimental',scoreKind:'approximate',warning:aiWarning},
    evaluationScope:{fullWords:205,evaluatedWords:205,truncated:false,evaluatedLimit:250},
    writingProgress:{
      version:'writing-progress-v1',attemptCount:simulatedWorks.size,average,works,
      confirmedAttempt:{...simulatedWorks.get(attemptId)},
    },
  };
}

function deferredResponse(response){
  let readyResolve,releaseResolve;
  const ready=new Promise(resolve=>{readyResolve=resolve});
  const released=new Promise(resolve=>{releaseResolve=resolve});
  return{
    ready,
    release(){releaseResolve()},
    async handle(route){readyResolve();await released;await route.fulfill(response)},
  };
}

function fulfilledJson(body,{status=200,owner='learner'}={}){
  return{status,contentType:'application/json',headers:{'X-EasyBoost-Response-Owner':owner},body:JSON.stringify(body)};
}

async function openPractice(page){
  await page.getByRole('navigation',{name:'Основные разделы'}).getByRole('button',{name:'Практика',exact:true}).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:8_000});
}

async function openWriting(page){
  if(!await page.locator('#aisy-practice.on').count())await openPractice(page);
  const row=page.locator('.practice-row[data-skill="writing"]');
  await row.getByRole('button',{name:/(?:Открыть|Продолжить): Письмо$/u}).press('Enter');
  await page.locator('#scr8.on #w_editor').waitFor({state:'visible',timeout:8_000});
}

async function writingMetrics(page,screenId,contentId,primaryId){
  return page.evaluate(({screenId,contentId,primaryId})=>{
    const rect=node=>node.getBoundingClientRect();
    const screen=document.getElementById(screenId),frame=document.getElementById('frame');
    const route=screen.querySelector('.writing-route'),content=document.getElementById(contentId);
    const dock=screen.querySelector('.writing-action-dock'),primary=document.getElementById(primaryId);
    const screenRect=rect(screen),frameRect=rect(frame),routeRect=rect(route),contentRect=rect(content),dockRect=rect(dock),ctaRect=rect(primary);
    const cta=getComputedStyle(primary),affordance=getComputedStyle(primary,'::after');
    const controls=[...screen.querySelectorAll('button,textarea'),document.getElementById('aisy-shell-back')]
      .filter(control=>control&&!control.hidden&&control.getClientRects().length)
      .map(control=>{const bounds=rect(control);return{label:control.getAttribute('aria-label')||control.textContent.trim(),width:bounds.width,height:bounds.height}});
    return{
      viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
      frame:{width:frameRect.width,left:frameRect.left,right:frameRect.right,height:frameRect.height},
      screen:{width:screenRect.width,height:screenRect.height,bottom:screenRect.bottom,scrollWidth:screen.scrollWidth,clientWidth:screen.clientWidth},
      route:{width:routeRect.width,height:routeRect.height,rows:getComputedStyle(route).gridTemplateRows},
      content:{height:contentRect.height,bottom:contentRect.bottom,scrollHeight:content.scrollHeight,clientHeight:content.clientHeight},
      dock:{top:dockRect.top,bottom:dockRect.bottom,height:dockRect.height},
      cta:{height:ctaRect.height,radius:cta.borderRadius,paddingLeft:cta.paddingLeft,paddingRight:cta.paddingRight,affordanceWidth:affordance.width,affordanceHeight:affordance.height},
      primaryCount:dock.querySelectorAll('.writing-primary:not([hidden])').length,
      backCount:document.querySelectorAll('#aisy-shell-back:not([hidden])').length,
      nav:{hidden:document.getElementById('aisy-shell-nav').hidden,inert:document.getElementById('aisy-shell-nav').inert},
      localNav:screen.querySelectorAll('.navclay').length,controls,
    };
  },{screenId,contentId,primaryId});
}

function assertLayout(metrics,label){
  assert.ok(metrics.document.width<=metrics.viewport.width,`${label}: document horizontal overflow ${JSON.stringify(metrics)}`);
  assert.ok(metrics.document.height<=metrics.viewport.height,`${label}: document vertical overflow ${JSON.stringify(metrics)}`);
  assert.ok(metrics.frame.width<=390.5,`${label}: app is not a portrait-phone canvas`);
  if(metrics.viewport.width>390)assert.ok(Math.abs(metrics.frame.left-(metrics.viewport.width-metrics.frame.width)/2)<=1,`${label}: phone canvas is not centered`);
  assert.ok(metrics.screen.scrollWidth<=metrics.screen.clientWidth+1,`${label}: deep screen overflow`);
  assert.ok(metrics.route.height>0&&metrics.content.height>0,`${label}: Writing grid collapsed`);
  assert.ok(metrics.content.bottom<=metrics.dock.top+1,`${label}: dock covers scroll content ${JSON.stringify({content:metrics.content,dock:metrics.dock,route:metrics.route})}`);
  assert.ok(metrics.dock.bottom<=metrics.screen.bottom+1&&metrics.screen.bottom<=metrics.viewport.height+1,`${label}: dock leaves phone viewport`);
  assert.equal(metrics.primaryCount,1,`${label}: one primary action must live in the dock`);
  assert.equal(Math.round(metrics.cta.height),58,`${label}: CTA height`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.radius)),28,`${label}: CTA radius`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.paddingLeft)),26,`${label}: CTA left padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.paddingRight)),10,`${label}: CTA right padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.affordanceWidth)),38,`${label}: CTA affordance width`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.affordanceHeight)),38,`${label}: CTA affordance height`);
  assert.equal(metrics.backCount,1,`${label}: canonical shell Back count`);
  assert.deepEqual(metrics.nav,{hidden:true,inert:true},`${label}: deep bottom navigation`);
  assert.equal(metrics.localNav,0,`${label}: local duplicate navigation`);
  assert.equal(metrics.controls.every(control=>control.width>=44&&control.height>=44),true,
    `${label}: undersized control ${JSON.stringify(metrics.controls.filter(control=>control.width<44||control.height<44))}`);
}

async function assertMatrix(page,screenId,contentId,primaryId,state){
  for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assertLayout(await writingMetrics(page,screenId,contentId,primaryId),`${state} · ${viewport.label}`);
  }
}

async function confirmationMetrics(page){
  return page.evaluate(()=>{
    const rect=node=>node.getBoundingClientRect();
    const dialog=document.getElementById('writing_confirm_dialog');
    const paper=dialog.querySelector('.writing-confirm__paper');
    const actions=dialog.querySelector('.writing-confirm__actions');
    const primary=document.getElementById('writing_confirm_accept');
    const cancel=document.getElementById('writing_confirm_cancel');
    const dialogRect=rect(dialog),paperRect=rect(paper),actionsRect=rect(actions),primaryRect=rect(primary),cancelRect=rect(cancel);
    const primaryStyle=getComputedStyle(primary),affordance=getComputedStyle(primary,'::after');
    return{
      viewport:{width:innerWidth,height:innerHeight},
      documentWidth:document.documentElement.scrollWidth,
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      theme:{preference:window.AisyTheme.preference,root:document.documentElement.dataset.theme||null,
        rootScheme:getComputedStyle(document.documentElement).colorScheme,dialogScheme:getComputedStyle(dialog).colorScheme},
      open:dialog.open,
      dialog:{left:dialogRect.left,right:dialogRect.right,top:dialogRect.top,bottom:dialogRect.bottom,width:dialogRect.width},
      paper:{left:paperRect.left,right:paperRect.right,background:getComputedStyle(paper).backgroundColor},
      actions:{width:actionsRect.width,columns:getComputedStyle(actions).gridTemplateColumns},
      primary:{
        width:primaryRect.width,height:primaryRect.height,top:primaryRect.top,
        radius:primaryStyle.borderRadius,paddingLeft:primaryStyle.paddingLeft,paddingRight:primaryStyle.paddingRight,
        background:primaryStyle.backgroundColor,transitionDuration:primaryStyle.transitionDuration,
        affordanceWidth:affordance.width,affordanceHeight:affordance.height,
      },
      cancel:{width:cancelRect.width,height:cancelRect.height,bottom:cancelRect.bottom},
      primaryCount:dialog.querySelectorAll('.writing-primary:not(.aisy-button--secondary)').length,
    };
  });
}

function assertConfirmationLayout(metrics,label){
  assert.equal(metrics.open,true,`${label}: dialog is open`);
  assert.equal(metrics.reducedMotion,true,`${label}: reduced-motion preference remains active`);
  assert.ok(metrics.documentWidth<=metrics.viewport.width,`${label}: dialog creates horizontal overflow`);
  assert.ok(metrics.dialog.left>=0&&metrics.dialog.right<=metrics.viewport.width+1,`${label}: dialog stays in the phone viewport`);
  assert.ok(metrics.dialog.top>=0&&metrics.dialog.bottom<=metrics.viewport.height+1,`${label}: dialog stays vertically reachable`);
  assert.ok(metrics.paper.left>=metrics.dialog.left-1&&metrics.paper.right<=metrics.dialog.right+1,`${label}: Paper surface stays inside dialog`);
  assert.equal(metrics.primaryCount,1,`${label}: exactly one canonical primary CTA`);
  assert.ok(Math.abs(metrics.primary.width-metrics.actions.width)<=1,`${label}: primary CTA fills its action row`);
  assert.equal(Math.round(metrics.primary.height),58,`${label}: primary CTA height`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.radius)),28,`${label}: primary CTA radius`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.paddingLeft)),26,`${label}: primary CTA left padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.paddingRight)),10,`${label}: primary CTA right padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.affordanceWidth)),38,`${label}: primary CTA affordance width`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.affordanceHeight)),38,`${label}: primary CTA affordance height`);
  assert.equal(metrics.primary.background,'rgb(185, 67, 58)',`${label}: canonical dark-coral primary`);
  assert.ok(metrics.cancel.width>=44&&metrics.cancel.height>=48,`${label}: cancel remains a phone-safe touch target`);
  assert.ok(metrics.primary.top>=metrics.cancel.bottom,`${label}: cancel and primary remain separate actions`);
}

async function assertConfirmationMatrix(page,state){
  const previousViewport=page.viewportSize();
  const previousTheme=await page.evaluate(()=>window.AisyTheme.preference);
  for(const viewport of [
    {width:320,height:720,label:'320×720'},
    {width:375,height:812,label:'375×812'},
    {width:390,height:844,label:'390×844'},
  ]){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const metrics=await confirmationMetrics(page);
    assertConfirmationLayout(metrics,`${state} · ${viewport.label} · light/reduced`);
    assert.equal(metrics.primary.transitionDuration.split(',').every(value=>Number.parseFloat(value)<=0.1),true,
      `${state} · ${viewport.label}: reduced motion keeps CTA transitions negligible`);
  }
  await page.evaluate(()=>window.AisyTheme.set('dark'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const darkMetrics=await confirmationMetrics(page);
  assertConfirmationLayout(darkMetrics,`${state} · 390×844 · dark/reduced`);
  assert.deepEqual(darkMetrics.theme,{preference:'dark',root:'dark',rootScheme:'dark',dialogScheme:'dark'},
    `${state}: the modal inherits the active dark color scheme`);
  await page.evaluate(theme=>window.AisyTheme.set(theme),previousTheme);
  if(previousViewport)await page.setViewportSize(previousViewport);
}

let browser,child,temporaryDirectory;
try{
  temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'aisy-writing-paper-'));
  const port=await availablePort(),baseUrl=`http://127.0.0.1:${port}`,now=Date.now();
  const dataFile=path.join(temporaryDirectory,'data.json');
  const user=created=>({created,sub_until:created+86_400_000,privacy_consent:{text_processing:true,voice_processing:false,policy_version:'2026-08-26-vk-id-v1',updated_at:new Date(created).toISOString()}});
  await fs.writeFile(dataFile,JSON.stringify({
    users:{learner:user(now),'owner-a':user(now),'owner-b':user(now)},
    progress:{learner:{},'owner-a':{},'owner-b':{}},
    subscription_entitlements:{learner:{voice_tutor:{starts_at:new Date(now-1000).toISOString(),ends_at:new Date(now+86_400_000).toISOString()}}},
  }),'utf8');
  const output=[];
  child=spawn(process.execPath,[serverPath],{cwd:projectDirectory,env:{
    ...process.env,NODE_ENV:'test',PORT:String(port),APP_URL:baseUrl,DATABASE_PROVIDER:'file',DATA_FILE:dataFile,JWT_SECRET:jwtSecret,
    TELEGRAM_BOT_TOKEN:'',ADMIN_TELEGRAM_ID:'',XAI_ENABLED:'false',GROQ_ENABLED:'false',VOICE_TUTOR_ENABLED:'false',ADAPTIVE_LEARNING_ENABLED:'false',
  },stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output.push(chunk.toString()));child.stderr.on('data',chunk=>output.push(chunk.toString()));
  await waitForReady(baseUrl,child,output);
  browser=await chromium.launch({headless:true,executablePath:await chromeExecutable()});

  const session=await createActiveSubscriptionPage(browser,{baseUrl,username:'learner',jwtSecret,contextOptions:{viewport:{width:320,height:720},colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block'}});
  const {context,page}=session,pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  const taskRequests=[],evaluationRequests=[],evaluationPlans=[];
  const longGeneratedTask=deferredResponse(fulfilledJson({
    taskId:'91',externalId:'generated:writing-37:long-unbroken',source:'generated',
    task:{
      from:'VeryLongSenderNameWithoutAnySpacesAtAll',
      stim:`${'UnbrokenStimulusToken'.repeat(28)}? ${'SecondQuestionToken'.repeat(12)}? ${'ThirdQuestionToken'.repeat(12)}?`,
      ask:'UnbrokenQuestionTopic'.repeat(5),
    },
  }));
  let firstTaskRequest=true;
  await page.route('**/api/v1/tasks/next',async route=>{
    taskRequests.push({headers:route.request().headers(),body:route.request().postDataJSON()});
    if(firstTaskRequest){firstTaskRequest=false;await longGeneratedTask.handle(route);return}
    await route.fulfill(fulfilledJson({taskId:'1',externalId:'builtin:writing_37:emily-new-flat',task:{from:'Emily',stim:'How are you? What do you like? Where do you study?',ask:'her new flat'},source:'builtin'}));
  });
  await page.route('**/api/v1/ai/evaluate-writing',async route=>{
    evaluationRequests.push({headers:route.request().headers(),body:route.request().postDataJSON()});
    const plan=evaluationPlans.shift();
    if(!plan)throw new Error('Unexpected Writing evaluation');
    await plan.handle(route);
  });
  await page.goto(baseUrl,{waitUntil:'networkidle'});await page.locator('#scr1.on').waitFor({state:'visible',timeout:8_000});await openWriting(page);
  await longGeneratedTask.ready;
  assert.equal(await page.evaluate(()=>document.querySelector('#scr8.on main[data-aisy-shell-focus]')?.contains(document.activeElement)),true,'editor route owns focus after navigation');
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  assert.equal(await page.locator('#scr8 .writing-route').evaluate(node=>getComputedStyle(node).backgroundColor)!=='rgba(0, 0, 0, 0)',true);
  await assertMatrix(page,'scr8','w8_area','writing_primary_action','Writing editor');
  await page.setViewportSize({width:320,height:720});
  await page.locator('#w_editor').focus();
  assert.equal(await page.locator('#w_editor').evaluate(node=>Number.parseFloat(getComputedStyle(node).outlineWidth)>=3),true,'textarea keeps a visible keyboard focus ring');

  await page.locator('#w_seg37').press('Enter');
  const guideToggle=page.getByRole('button',{name:'Шпаргалка',exact:true});
  assert.equal(await guideToggle.getAttribute('aria-controls'),'w_guide');
  assert.equal(await guideToggle.getAttribute('aria-expanded'),'false');
  await guideToggle.focus();await guideToggle.press('Enter');
  assert.equal(await page.locator('#w_guide_toggle').getAttribute('aria-expanded'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'w_guide_toggle','opening the guide restores focus to its replacement toggle');
  await page.locator('#w_guide_toggle').press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'w_guide_toggle','closing the guide restores focus to its replacement toggle');
  await page.locator('#w_editor').fill(Array.from({length:99},()=> 'word').join(' '));
  await page.locator('#w_editor').fill(Array.from({length:100},()=> 'word').join(' '));
  await page.getByText('Объём в норме: 100 слов.',{exact:true}).waitFor({state:'attached'});
  const task37Draft='Dear Emily,\n\nThanks for your email. I am fine and I enjoy reading after school. I study near my home.\n\nWhat is your flat like? Where is it? Do you like it?\n\nBest wishes,\nAnn';
  const syncedDraftRequest=page.waitForRequest(request=>{
    if(new URL(request.url()).pathname!=='/api/v1/progress/modules'||request.method()!=='POST')return false;
    try{return Object.values(request.postDataJSON()?.modules?.drafts||{}).includes(task37Draft)}catch(_){return false}
  });
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;window.__restoreWritingDraftQueue=()=>{Storage.prototype.setItem=original};
    Storage.prototype.setItem=function(key,value){
      if(String(key)==='easyboost_pending_modules_v3')throw new DOMException('Queue unavailable','QuotaExceededError');
      return original.call(this,key,value);
    };
  });
  await page.locator('#w_editor').fill(task37Draft);
  await page.getByText('Черновик сохранён на этом устройстве',{exact:true}).waitFor({state:'visible'});
  assert.doesNotMatch(await page.locator('#w_draft_status').innerText(),/синхрон/iu,
    'a local snapshot never claims account synchronization when the pending queue write fails');
  await page.evaluate(()=>window.__restoreWritingDraftQueue());
  await page.locator('#w_editor').fill(task37Draft+' ');await page.locator('#w_editor').fill(task37Draft);
  const syncedDraft=(await syncedDraftRequest).postDataJSON();
  assert.equal(Object.values(syncedDraft.modules.drafts).includes(task37Draft),true,
    'the deferred account synchronization still sends the exact draft after queue storage recovers');
  const stableBeforeAppend=await page.evaluate(()=>({
    index:window.S.wIdx37,prompt:document.getElementById('w_prompt').innerText,
    draftKey:document.getElementById('w_editor').dataset.draftKey,
  }));
  longGeneratedTask.release();
  await page.waitForFunction(()=>window.S.writeAi?.t37?.some(task=>task.id==='generated:writing-37:long-unbroken'));
  assert.deepEqual(await page.evaluate(()=>({
    index:window.S.wIdx37,prompt:document.getElementById('w_prompt').innerText,
    draftKey:document.getElementById('w_editor').dataset.draftKey,
  })),stableBeforeAppend,'a late generated task cannot change the visible assignment behind a draft');
  assert.equal(await page.evaluate(()=>{
    for(let step=0;step<50;step+=1){
      window.wrNext();
      if(document.getElementById('w_prompt').innerText.includes('UnbrokenStimulusToken'))return true;
    }
    return false;
  }),true,'the generated task is reachable without assuming a fixed built-in pool length');
  await page.getByText(/UnbrokenStimulusToken/u).waitFor({state:'visible'});
  assert.equal(await page.locator('#scr8').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'unbroken task-bank content wraps at 320px');
  assert.equal(await page.evaluate(draftKey=>{
    for(let step=0;step<50;step+=1){
      window.wrNext();
      if(document.getElementById('w_editor').dataset.draftKey===draftKey)return true;
    }
    return false;
  },stableBeforeAppend.draftKey),true,'the original identity remains reachable after appending a generated task');
  assert.equal(await page.locator('#w_editor').inputValue(),task37Draft,'identity-stable cycling restores the original draft');
  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({state:'visible'});await openWriting(page);
  assert.equal(await page.locator('#w_seg37').getAttribute('aria-checked'),'true');
  assert.equal(await page.locator('#w_editor').inputValue(),task37Draft,'resume preserves type and all newlines');

  await page.locator('#w_seg38').press('Enter');
  const answer='First paragraph with project context.\n\nSecond paragraph contains survey facts and useful evidence.\n\nThird paragraph compares two figures.\n\nFourth paragraph explains a problem and solution.\n\nIn conclusion, this is my opinion.';
  await page.locator('#w_editor').fill(answer);
  const longSuccess=deferredResponse(fulfilledJson(successBody({verdict:'Изолированный браузерный разбор готов',long:true})));
  evaluationPlans.push(longSuccess);
  const baseline=await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0}));
  await page.evaluate(()=>{document.getElementById('writing_primary_action').click();window.checkWriting()});
  await longSuccess.ready;await page.locator('#scr13.on').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.querySelector('#scr13.on main[data-aisy-shell-focus]')===document.activeElement),true,'waiting route receives managed focus');
  assert.equal(evaluationRequests.length,1,'double submit must produce one paid evaluation request');
  assert.equal(await page.locator('#writing_primary_action').isDisabled(),true);
  assert.equal(await page.locator('#scr13 .writing-route').getAttribute('data-phase'),'dispatched');
  assert.equal(await page.locator('#scr13 .writing-route').getAttribute('aria-busy'),'false','dispatch releases the waiting route announcement boundary');
  assert.equal(await page.locator('#w_waiting_content').getAttribute('aria-busy'),'false','dispatch releases the live status for truthful updates');
  assert.equal(await page.locator('#w_waiting_primary').getAttribute('aria-busy'),'true','only the disabled action remains visibly busy during evaluation');
  assert.match(await page.locator('#scr13').innerText(),/Ответ отправлен один раз/u);
  assert.equal(await page.locator('#scr13 .writing-waiting__mark').evaluate(node=>getComputedStyle(node).animationName),'none','reduced motion removes spinner rotation');
  assert.doesNotMatch(await page.locator('#scr13').innerText(),/~15|Орфография проверена|Анализ грамматики/u);
  assert.deepEqual(Object.keys(evaluationRequests[0].body).sort(),['answer','taskId','taskType']);
  assert.equal(evaluationRequests[0].body.answer,answer);assert.equal(evaluationRequests[0].body.taskType,'writing_38');
  assert.equal(evaluationRequests[0].headers['x-easyboost-expected-owner'],'learner');
  assert.ok(evaluationRequests[0].headers['idempotency-key']);
  await assertMatrix(page,'scr13','w_waiting_content','w_waiting_primary','Writing waiting');
  await page.setViewportSize({width:320,height:720});
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;window.__restoreWritingProgressQueue=()=>{Storage.prototype.setItem=original};
    Storage.prototype.setItem=function(key,value){
      if(String(key)==='easyboost_pending_modules_v3')throw new DOMException('Queue unavailable','QuotaExceededError');
      return original.call(this,key,value);
    };
  });
  longSuccess.release();
  await page.locator('#scr12.on').waitFor({state:'visible',timeout:8_000});
  assert.equal(await page.evaluate(()=>document.querySelector('#scr12.on main[data-aisy-shell-focus]')===document.activeElement),true,'review route receives managed focus');
  await page.getByText('Изолированный браузерный разбор готов').waitFor({state:'visible'});
  assert.equal(await page.locator('#rv_score').innerText(),'11');
  assert.equal(await page.locator('#rv_saved_notice').innerText(),'Разбор сохранён на сервере · серверный прогресс обновлён');
  assert.doesNotMatch(await page.locator('#rv_saved_notice').innerText(),/Балл.*сохранён|прогресс сохранён/iu);
  await page.evaluate(()=>window.__restoreWritingProgressQueue());
  assert.match(await page.locator('#ai_disclaimer').innerText(),/Балл ориентировочный/u);
  const reviewNoticeMetrics=await page.evaluate(()=>{
    const warning=document.getElementById('ai_disclaimer').getBoundingClientRect();
    const card=document.querySelector('.writing-review__score'),style=getComputedStyle(card);
    const contentWidth=card.clientWidth-Number.parseFloat(style.paddingLeft)-Number.parseFloat(style.paddingRight);
    return{warning:warning.width,contentWidth};
  });
  assert.ok(reviewNoticeMetrics.warning>=reviewNoticeMetrics.contentWidth-1,
    `assessment and scope notices span the review card instead of wrapping in the score column: ${JSON.stringify(reviewNoticeMetrics)}`);
  assert.equal(await page.getByRole('button',{name:'Сохранить в прогресс'}).count(),0);
  assert.match(await page.locator('#rv_err').innerText(),/Фрагмент из работы/iu);
  assert.match(await page.locator('#rv_err').innerText(),/Правильный вариант/iu);
  assert.match(await page.locator('#rv_err').innerText(),/Правило/iu);
  assert.match(await page.locator('#rv_err').innerText(),/Separate teaching example/iu);
  assert.deepEqual(await page.locator('.writing-feedback').first().locator('dt').allTextContents(),[
    'Правильный вариант','Правило','Пример','Фрагмент из работы',
  ],'review teaches correction, reusable rule and one example before showing learner evidence');
  assert.deepEqual(await page.locator('.writing-feedback').nth(1).locator('dt').allTextContents(),[
    'Правильный вариант','Правило','Пример','Фрагмент из работы',
  ],'a corrective warning keeps its evidence and correction instead of hiding them by visual kind');
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+1,essays:baseline.essays+1});
  assert.equal(await page.evaluate(submitted=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    const records=JSON.parse(localStorage.getItem(storageKey)||'{"records":[]}').records||[];
    return records.some(record=>record.payload?.answer===submitted);
  },answer),false,'an applied server result retires its local essay-bearing retry envelope');
  assert.equal(await page.locator('.writing-route .voiceTutorTrigger').first().evaluate(node=>{
    const style=getComputedStyle(node),box=node.getBoundingClientRect();
    return box.height>=44&&Number.parseFloat(style.fontSize)>=16&&style.backgroundColor!=='rgba(0, 0, 0, 0)';
  }),true,'Premium Voice Tutor action is Paper-styled and touch-readable before its lazy runtime loads');
  assert.equal(await page.evaluate(()=>{
    const selectors=['.writing-history__item','.writing-criterion strong','.writing-feedback h3','.writing-error__kind'];
    return selectors.filter(selector=>document.querySelector(selector)).every(selector=>Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)>=16);
  }),true,'learner-facing Writing content stays at least 16px');
  await assertMatrix(page,'scr12','rv_content','rv_primary_action','Writing review');
  await page.setViewportSize({width:720,height:320});
  assert.equal(await page.locator('#rv_content').evaluate(node=>{node.scrollTop=node.scrollHeight;const last=node.querySelector('.writing-feedback:last-of-type').getBoundingClientRect(),area=node.getBoundingClientRect();return last.bottom<=area.bottom+1}),true,'long landscape feedback remains reachable');
  const lightBackground=await page.locator('#scr12 .writing-route').evaluate(node=>getComputedStyle(node).backgroundColor);
  await page.evaluate(()=>window.AisyTheme.set('dark'));
  await page.waitForFunction(previous=>getComputedStyle(document.querySelector('#scr12 .writing-route')).backgroundColor!==previous,lightBackground);
  assert.notEqual(await page.locator('#scr12 .writing-route').evaluate(node=>getComputedStyle(node).backgroundColor),lightBackground);
  await page.evaluate(()=>window.AisyTheme.set('light'));await page.setViewportSize({width:320,height:720});

  await page.getByRole('button',{name:'Исправить',exact:true}).press('Enter');
  await page.locator('#scr8.on #w_editor').waitFor({state:'visible'});
  assert.equal(await page.locator('#w_editor').inputValue(),answer,'explicit edit keeps exact submitted text');
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson({error:{code:'RATE_LIMITED',message:'Слишком много запросов.'}},{status:429}))});
  await page.locator('#writing_primary_action').press('Enter');
  await page.locator('#rv_error_state:not([hidden])').waitFor({state:'visible',timeout:8_000});
  assert.match(await page.locator('#rv_error_title').innerText(),/Слишком много запросов/u);
  assert.equal(await page.locator('#rv_saved_notice').isHidden(),true,'a failed review never claims that a score was saved');
  assert.equal(await page.evaluate(()=>document.querySelector('#scr12.on main[data-aisy-shell-focus]')===document.activeElement),true,'failure route receives managed focus');
  assert.equal(await page.locator('#rv_result').isHidden(),true,'failure must not expose a score');
  assert.equal(await page.evaluate(()=>{
    const action=document.getElementById('rv_primary_action').getBoundingClientRect();
    const actions=document.querySelector('.writing-dock-actions--review').getBoundingClientRect();
    return Math.abs(action.width-actions.width)<=1;
  }),true,'single failure CTA spans the full action dock');
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+1,essays:baseline.essays+1},'failed evaluation creates no evidence');
  await page.evaluate(()=>window.tab('scr8'));await page.locator('#scr8.on').waitFor({state:'visible'});
  assert.equal(await page.locator('#w_editor').inputValue(),answer,'classified failure preserves the draft');

  const beforeStorageFailure=evaluationRequests.length;
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;window.__restoreWritingStorage=()=>{Storage.prototype.setItem=original};
    Storage.prototype.setItem=function(key,value){
      if(String(key).startsWith('easyboost.writing-evaluation.v1:')||String(key).startsWith('eb_data_learner'))
        throw new DOMException('Quota exceeded','QuotaExceededError');
      return original.call(this,key,value);
    };
  });
  const quotaDraft=`${answer}\n\nThis line is still visible but local persistence is blocked.`;
  await page.locator('#w_editor').fill(quotaDraft);
  await page.getByText('Не удалось сохранить черновик на этом устройстве — не закрывайте страницу',{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.locator('#w_editor').inputValue(),quotaDraft,'storage failure preserves the live editor text');
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Не удалось безопасно начать проверку',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.length,beforeStorageFailure,'retry-storage quota failure must stop before provider API');
  assert.equal(await page.locator('#rv_result').isHidden(),true);
  await page.evaluate(()=>window.__restoreWritingStorage());
  assert.equal(await page.locator('#rv_primary_action').innerText(),'Вернуться к работе');
  await page.locator('#rv_primary_action').press('Enter');
  assert.equal(await page.locator('#w_editor').inputValue(),quotaDraft,'storage failure preserves exact draft in the current page');
  await page.locator('#w_editor').fill(answer);

  const settlementUnknown=()=>fulfilledJson({error:{
    code:'WRITING_EVALUATION_SETTLEMENT_UNKNOWN',message:'Provider result is ambiguous.',
  }},{status:503});
  evaluationPlans.push({handle:route=>route.fulfill(settlementUnknown())});
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible',timeout:8_000});
  const ambiguousProviderRequest=evaluationRequests.at(-1);
  assert.equal(await page.getByRole('button',{name:'Проверить статус',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Проверить заново',exact:true}).count(),1);
  const canonicalVariant=`${answer}  \u200B`;
  await page.evaluate(value=>{document.getElementById('w_editor').value=value},canonicalVariant);
  evaluationPlans.push({handle:route=>route.fulfill(settlementUnknown())});
  await page.getByRole('button',{name:'Проверить статус',exact:true}).press('Enter');
  await page.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible'});
  const statusRequest=evaluationRequests.at(-1);
  assert.equal(statusRequest.headers['idempotency-key'],ambiguousProviderRequest.headers['idempotency-key'],'status poll keeps exact key');
  assert.equal(statusRequest.headers['x-easyboost-acknowledge-provider-repeat'],undefined,'status poll never acknowledges paid repeat');
  assert.equal(statusRequest.body.answer,canonicalVariant,'the exact wire payload remains the learner text');
  await page.evaluate(value=>{document.getElementById('w_editor').value=value},answer);

  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson({error:{code:'RATE_LIMITED',message:'Too many requests.'}},{status:429}))});
  const beforeCancelledRepeat=evaluationRequests.length;
  await page.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter');
  const repeatDialog=page.getByRole('dialog',{name:'Повторить платную проверку?',exact:true});
  await repeatDialog.waitFor({state:'visible'});
  await assertConfirmationMatrix(page,'Writing paid-repeat confirmation');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'writing_confirm_cancel');
  await page.locator('#writing_confirm_accept').focus();await page.locator('#writing_confirm_accept').press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'writing_confirm_cancel','Tab wraps from the last dialog action');
  await page.locator('#writing_confirm_cancel').press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'writing_confirm_accept','Shift+Tab wraps from the first dialog action');
  await page.locator('#writing_confirm_dialog').press('Escape');await repeatDialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'rv_edit_action','Escape closes the Paper dialog and restores trigger focus');
  assert.equal(evaluationRequests.length,beforeCancelledRepeat,'cancelling the dialog dispatches no paid repeat');
  await page.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter');
  await repeatDialog.waitFor({state:'visible'});await repeatDialog.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter');
  await page.getByText('Слишком много запросов',{exact:true}).waitFor({state:'visible'});
  const rejectedAcknowledgement=evaluationRequests.at(-1);
  assert.notEqual(rejectedAcknowledgement.headers['idempotency-key'],ambiguousProviderRequest.headers['idempotency-key']);
  assert.equal(rejectedAcknowledgement.headers['x-easyboost-acknowledge-provider-repeat'],ambiguousProviderRequest.headers['idempotency-key']);

  evaluationPlans.push({handle:route=>route.fulfill(settlementUnknown())});
  await page.getByRole('button',{name:'Повторить проверку',exact:true}).press('Enter');
  await page.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.at(-1).headers['idempotency-key'],ambiguousProviderRequest.headers['idempotency-key'],'pre-claim rejection preserves the original status key');
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson(successBody({verdict:'Осознанный повтор завершён',attemptId:703})))});
  await page.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter');
  await page.getByRole('dialog',{name:'Повторить платную проверку?',exact:true}).waitFor({state:'visible'});
  await page.getByRole('dialog',{name:'Повторить платную проверку?',exact:true}).getByRole('button',{name:'Проверить заново',exact:true}).press('Enter');
  await page.getByText('Осознанный повтор завершён',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.at(-1).headers['x-easyboost-acknowledge-provider-repeat'],ambiguousProviderRequest.headers['idempotency-key']);
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+2,essays:baseline.essays+2},'acknowledged repeat creates evidence only from its real server attempt');
  await page.getByRole('button',{name:'Исправить',exact:true}).press('Enter');

  const malformedReview=()=>fulfilledJson({review:{overall_got:11,overall_max:14,criteria:null},provider:'test',attemptId:705});
  evaluationPlans.push({handle:route=>route.fulfill(malformedReview())});
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible'});
  const malformedRequest=evaluationRequests.at(-1);
  assert.equal(await page.getByRole('button',{name:'Проверить заново',exact:true}).count(),0,
    'a malformed successful response never offers a possibly-paid repeat');
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson(successBody({verdict:'Некорректный ответ восстановлен проверкой статуса',attemptId:705})))});
  await page.getByRole('button',{name:'Проверить статус',exact:true}).press('Enter');
  await page.getByText('Некорректный ответ восстановлен проверкой статуса',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.at(-1).headers['idempotency-key'],malformedRequest.headers['idempotency-key'],
    'a malformed 2xx can recover only by polling the exact possibly-paid key');
  assert.equal(evaluationRequests.at(-1).headers['x-easyboost-acknowledge-provider-repeat'],undefined);
  await page.getByRole('button',{name:'Исправить',exact:true}).press('Enter');

  evaluationPlans.push({handle:route=>route.abort('failed')});
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Нет связи для проверки',{exact:true}).waitFor({state:'visible',timeout:8_000});
  const ambiguousRequest=evaluationRequests.at(-1);
  assert.ok(ambiguousRequest.headers['idempotency-key']);
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+3,essays:baseline.essays+3},'ambiguous network failure creates no local evidence');
  const beforeReloadDraft=await page.evaluate(()=>({taskType:window.S.writingTaskType,index:window.S.wIdx38,drafts:window.S.drafts}));

  await page.reload({waitUntil:'networkidle'});await page.locator('#scr1.on').waitFor({state:'visible',timeout:8_000});await openWriting(page);
  assert.equal(await page.locator('#w_seg38').getAttribute('aria-checked'),'true');
  const afterReloadDraft=await page.evaluate(()=>({taskType:window.S.writingTaskType,index:window.S.wIdx38,drafts:window.S.drafts,editor:document.getElementById('w_editor').value,key:document.getElementById('w_editor').dataset.draftKey}));
  assert.equal(await page.locator('#w_editor').inputValue(),answer,`process restart keeps the exact ambiguous payload draft: ${JSON.stringify({beforeReloadDraft,afterReloadDraft})}`);
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson(successBody({verdict:'Потерянный ответ восстановлен',attemptId:702})))});
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Потерянный ответ восстановлен',{exact:true}).waitFor({state:'visible',timeout:8_000});
  const recoveredRequest=evaluationRequests.at(-1);
  assert.equal(recoveredRequest.headers['idempotency-key'],ambiguousRequest.headers['idempotency-key'],'ambiguous retry reuses the exact persisted key after reload');
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+4,essays:baseline.essays+4},'recovered server attempt creates evidence exactly once');

  await page.getByRole('button',{name:'Исправить',exact:true}).press('Enter');
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson(successBody({verdict:'Тот же серверный attempt replayed',attemptId:702})))});
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Тот же серверный attempt replayed',{exact:true}).waitFor({state:'visible',timeout:8_000});
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+4,essays:baseline.essays+4},'attemptId replay cannot duplicate works or essays');
  await page.getByRole('button',{name:'Исправить',exact:true}).press('Enter');

  const staleSuccess=deferredResponse(fulfilledJson(successBody({verdict:'Поздний ответ не должен появиться',attemptId:704})));
  evaluationPlans.push(staleSuccess);
  await page.locator('#writing_primary_action').press('Enter');await staleSuccess.ready;
  const staleViewRequest=evaluationRequests.at(-1);
  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({state:'visible'});staleSuccess.release();await page.waitForTimeout(250);
  assert.equal(await page.locator('#scr12.on').count(),0,'late response cannot reopen review after leaving the view');
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+4,essays:baseline.essays+4});
  await page.reload({waitUntil:'networkidle'});await page.locator('#scr1.on').waitFor({state:'visible',timeout:8_000});await openWriting(page);
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson(successBody({verdict:'Поздний серверный ответ восстановлен',attemptId:704})))});
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Поздний серверный ответ восстановлен',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.at(-1).headers['idempotency-key'],staleViewRequest.headers['idempotency-key'],'late-view success keeps its key until explicit replay is applied after reload');
  assert.deepEqual(await page.evaluate(()=>({works:window.S.works?.length||0,essays:window.S.essays||0})),{works:baseline.works+5,essays:baseline.essays+5});

  await page.getByRole('button',{name:'Исправить',exact:true}).press('Enter');
  const sharedTabAnswer=`${answer}\n\nCross tab idempotency race.`;
  await page.locator('#w_editor').fill(sharedTabAnswer);
  const sibling=await context.newPage(),siblingErrors=[],siblingRequests=[],siblingPlans=[];
  sibling.on('pageerror',error=>siblingErrors.push(error.message));
  await sibling.route('**/api/v1/tasks/next',route=>route.fulfill(fulfilledJson({
    taskId:'1',externalId:'builtin:writing_37:emily-new-flat',source:'builtin',
    task:{from:'Emily',stim:'How are you? What do you like? Where do you study?',ask:'her new flat'},
  })));
  await sibling.route('**/api/v1/ai/evaluate-writing',async route=>{
    siblingRequests.push({headers:route.request().headers(),body:route.request().postDataJSON()});
    const plan=siblingPlans.shift();if(!plan)throw new Error('Unexpected sibling Writing evaluation');await plan.handle(route);
  });
  await sibling.goto(baseUrl,{waitUntil:'networkidle'});await sibling.locator('#scr1.on').waitFor({state:'visible'});await openWriting(sibling);
  await sibling.locator('#w_seg38').press('Enter');await sibling.locator('#w_editor').fill(sharedTabAnswer);
  evaluationPlans.push({handle:route=>route.fulfill(settlementUnknown())});
  siblingPlans.push({handle:route=>route.fulfill(settlementUnknown())});
  await Promise.all([
    page.locator('#writing_primary_action').press('Enter'),
    sibling.locator('#writing_primary_action').press('Enter'),
  ]);
  await Promise.all([
    page.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible'}),
    sibling.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible'}),
  ]);
  const tabFirst=[evaluationRequests.at(-1),siblingRequests.at(-1)];
  assert.equal(tabFirst[0].headers['idempotency-key'],tabFirst[1].headers['idempotency-key'],
    'same-origin tabs serialize exact-payload key creation through Web Locks');
  assert.equal(await page.evaluate(payload=>{
    const key=Object.keys(localStorage).find(item=>item.startsWith('easyboost.writing-evaluation.v1:learner:'));
    const records=JSON.parse(localStorage.getItem(key)||'{"records":[]}').records||[];
    return records.filter(record=>record.payload?.taskType===payload.taskType&&record.payload?.taskId===payload.taskId&&record.payload?.answer===payload.answer).length;
  },tabFirst[0].body),1,'cross-tab submission persists one canonical retry record');

  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson({error:{code:'RATE_LIMITED',message:'Too many requests.'}},{status:429}))});
  siblingPlans.push({handle:route=>route.fulfill(fulfilledJson({error:{code:'RATE_LIMITED',message:'Too many requests.'}},{status:429}))});
  await Promise.all([
    page.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter'),
    sibling.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter'),
  ]);
  const pageRepeatDialog=page.getByRole('dialog',{name:'Повторить платную проверку?',exact:true});
  const siblingRepeatDialog=sibling.getByRole('dialog',{name:'Повторить платную проверку?',exact:true});
  await Promise.all([pageRepeatDialog.waitFor({state:'visible'}),siblingRepeatDialog.waitFor({state:'visible'})]);
  await Promise.all([
    pageRepeatDialog.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter'),
    siblingRepeatDialog.getByRole('button',{name:'Проверить заново',exact:true}).press('Enter'),
  ]);
  await Promise.all([
    page.getByText('Слишком много запросов',{exact:true}).waitFor({state:'visible'}),
    sibling.getByText('Слишком много запросов',{exact:true}).waitFor({state:'visible'}),
  ]);
  const tabRepeat=[evaluationRequests.at(-1),siblingRequests.at(-1)];
  assert.equal(tabRepeat[0].headers['idempotency-key'],tabRepeat[1].headers['idempotency-key'],
    'same-origin tabs also serialize an acknowledged repeat key');
  assert.equal(tabRepeat[0].headers['x-easyboost-acknowledge-provider-repeat'],tabFirst[0].headers['idempotency-key']);
  assert.equal(tabRepeat[1].headers['x-easyboost-acknowledge-provider-repeat'],tabFirst[0].headers['idempotency-key']);

  await page.evaluate(()=>new Promise(acquired=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    navigator.locks.request(storageKey+':lock',()=>new Promise(release=>{window.__releaseWritingCrossTabLock=release;acquired(true)}));
  }));
  const siblingBeforeAbandon=siblingRequests.length;
  await sibling.getByRole('button',{name:'Повторить проверку',exact:true}).press('Enter');
  await sibling.locator('#scr13.on').waitFor({state:'visible'});
  assert.equal(await sibling.locator('#scr13 .writing-route').getAttribute('data-phase'),'preflight');
  assert.equal(await sibling.locator('#scr13 .writing-route').getAttribute('aria-busy'),'true');
  assert.equal(await sibling.locator('#w_waiting_content').getAttribute('aria-busy'),'true','preflight keeps the live status atomic until dispatch');
  assert.match(await sibling.locator('#scr13').innerText(),/Ответ ещё не передан на проверку/u);
  assert.doesNotMatch(await sibling.locator('#scr13').innerText(),/Ответ отправлен один раз/u);
  await sibling.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await sibling.locator('#aisy-practice.on').waitFor({state:'visible'});
  await page.evaluate(()=>window.__releaseWritingCrossTabLock());await page.waitForTimeout(100);
  assert.equal(siblingRequests.length,siblingBeforeAbandon,'a tab that leaves during preflight never dispatches');
  assert.equal(await page.evaluate(expectedKey=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    const records=JSON.parse(localStorage.getItem(storageKey)||'{"records":[]}').records||[];
    return records.some(record=>record.key===expectedKey);
  },tabFirst[0].headers['idempotency-key']),true,'abandoned reuse cannot delete another tab’s recovery key');
  evaluationPlans.push({handle:route=>route.fulfill(settlementUnknown())});
  await page.getByRole('button',{name:'Повторить проверку',exact:true}).press('Enter');
  await page.getByText('Результат ещё не подтверждён',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.at(-1).headers['idempotency-key'],tabFirst[0].headers['idempotency-key'],
    'the surviving canonical key still performs exact status replay');
  await page.evaluate(()=>window.tab('scr8'));await page.locator('#scr8.on').waitFor({state:'visible'});
  const capacityAnswer=`${answer}\n\nA fifth distinct recovery envelope must remain usable.`;
  await page.locator('#w_editor').fill(capacityAnswer);
  await page.evaluate(basePayload=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    const records=Array.from({length:4},(_,index)=>({
      key:crypto.randomUUID().toLowerCase(),createdAt:Date.now()-10_000+index,
      payload:{...basePayload,answer:`Pending distinct payload ${index} with enough words to be a different evaluation.`},
    }));
    localStorage.setItem(storageKey,JSON.stringify({records}));
  },evaluationRequests.at(-1).body);
  const beforeCapacity=evaluationRequests.length;
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Есть незавершённые проверки',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.length,beforeCapacity,'a full envelope store fails closed before provider dispatch');
  evaluationPlans.push({handle:route=>route.fulfill(fulfilledJson(successBody({verdict:'Пятая работа проверена после явного освобождения места',attemptId:707})))});
  const capacityRecordKeys=await page.evaluate(()=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    return (JSON.parse(localStorage.getItem(storageKey)||'{"records":[]}').records||[]).map(record=>record.key);
  });
  await page.evaluate(()=>new Promise(acquired=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    navigator.locks.request(storageKey+':lock',()=>new Promise(release=>{window.__releaseWritingRetirementLock=release;acquired(true)}));
  }));
  await page.getByRole('button',{name:'Освободить место',exact:true}).press('Enter');
  const retireDialog=page.getByRole('dialog',{name:'Освободить место для проверки?',exact:true});
  await retireDialog.waitFor({state:'visible'});
  await retireDialog.getByRole('button',{name:'Удалить запись',exact:true}).press('Enter');
  assert.equal(await page.getByRole('button',{name:'Освобождаем…',exact:true}).isDisabled(),true,
    'retirement CTA is disabled while the owner Web Lock is pending');
  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({state:'visible'});
  await page.evaluate(()=>window.__releaseWritingRetirementLock());await page.waitForTimeout(120);
  assert.equal(evaluationRequests.length,beforeCapacity,'leaving during retirement cannot dispatch a paid evaluation');
  assert.deepEqual(await page.evaluate(()=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    return (JSON.parse(localStorage.getItem(storageKey)||'{"records":[]}').records||[]).map(record=>record.key);
  }),capacityRecordKeys,'leaving before the retirement lock is acquired cannot delete a recovery record');
  assert.equal(await page.locator('#scr8.on, #scr12.on, #scr13.on').count(),0,'late retirement cannot reopen Writing');
  await openWriting(page);assert.equal(await page.locator('#w_editor').inputValue(),capacityAnswer);
  await page.locator('#writing_primary_action').press('Enter');
  await page.getByText('Есть незавершённые проверки',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.length,beforeCapacity);
  assert.equal(await page.getByRole('button',{name:'Освободить место',exact:true}).isEnabled(),true,
    'returning after an abandoned retirement restores the review CTA');
  await page.getByRole('button',{name:'Освободить место',exact:true}).press('Enter');
  await retireDialog.waitFor({state:'visible'});
  await retireDialog.getByRole('button',{name:'Удалить запись',exact:true}).press('Enter');
  await page.getByText('Пятая работа проверена после явного освобождения места',{exact:true}).waitFor({state:'visible'});
  assert.equal(evaluationRequests.length,beforeCapacity+1);
  assert.equal(await page.evaluate(()=>{
    const storageKey=Object.keys(localStorage).find(key=>key.startsWith('easyboost.writing-evaluation.v1:learner:'));
    return (JSON.parse(localStorage.getItem(storageKey)||'{"records":[]}').records||[]).length<=4;
  }),true,'explicit retirement keeps the bounded recovery store usable');
  assert.equal(await page.evaluate(()=>{
    const previous={works:window.S.works,essays:window.S.essays,prog:{...(window.S.prog||{})}};
    const summary=document.createElement('span');summary.id='sub_write';document.body.appendChild(summary);
    window.S.works=Array.from({length:30},(_,index)=>({
      attemptId:index+6,t:38,taskId:`recent-${index}`,g:10,m:14,n:220,ts:index+1,
    }));
    window.S.essays=35;window.S.prog={...window.S.prog,write:71};window.wrSyncTile();
    const text=summary.textContent;
    window.S.works=previous.works;window.S.essays=previous.essays;window.S.prog=previous.prog;window.wrSyncTile();
    summary.remove();
    return text;
  }),'работ: 35 · средний 71%','cold restore keeps the server total after recent history is capped at 30');
  assert.deepEqual(siblingErrors,[]);await sibling.close();
  assert.deepEqual(pageErrors,[]);await context.close();

  const race=await createActiveSubscriptionPage(browser,{baseUrl,username:'owner-a',jwtSecret,contextOptions:{viewport:{width:375,height:812},reducedMotion:'reduce',serviceWorkers:'block'}});
  const raceErrors=[];race.page.on('pageerror',error=>raceErrors.push(error.message));
  const lateTask=deferredResponse(fulfilledJson({taskId:'99',externalId:null,task:{topic:'Late A task',rows:[['One',40],['Two',30],['Three',20],['Four',10]]},source:'generated'},{owner:'owner-a'}));
  const lateEvaluation=deferredResponse(fulfilledJson(successBody({verdict:'Late A review'}),{owner:'owner-a'}));
  let ownerATaskRequests=0,ownerAEvaluations=0;
  await race.page.route('**/api/v1/tasks/next',async route=>{
    if(route.request().headers()['x-easyboost-expected-owner']==='owner-a'){ownerATaskRequests++;await lateTask.handle(route);return}
    await route.fulfill(fulfilledJson({taskId:'1',externalId:'builtin:writing_37:emily-new-flat',task:{from:'Emily',stim:'How are you? What do you like? Where do you study?',ask:'her flat'},source:'builtin'},{owner:'owner-b'}));
  });
  await race.page.route('**/api/v1/ai/evaluate-writing',async route=>{ownerAEvaluations++;await lateEvaluation.handle(route)});
  await race.page.goto(baseUrl,{waitUntil:'networkidle'});await race.page.locator('#scr1.on').waitFor({state:'visible'});await openWriting(race.page);await lateTask.ready;
  await race.page.locator('#w_editor').fill(answer);await race.page.locator('#writing_primary_action').press('Enter');await lateEvaluation.ready;
  await race.page.evaluate(()=>{
    const ring=document.getElementById('rv_ring');ring.value=11;ring.max=14;
    const scope=document.getElementById('rv_scope_notice');scope.hidden=false;scope.textContent='Owner A private scope';
    const draft=document.getElementById('w_draft_status');draft.textContent='Owner A private storage error';draft.dataset.state='error';
    const editorError=document.getElementById('w_editor_error');editorError.textContent='Owner A private validation';editorError.hidden=false;
  });
  const ownerAMarker=await race.page.evaluate(()=>window.EasyBoostStore.readCurrentOwner());
  const ownerARetryEnvelope=await race.page.evaluate(owner=>{
    const prefix=`easyboost.writing-evaluation.v1:${encodeURIComponent(owner.owner)}:${owner.ownerGeneration}`;
    return {key:prefix,value:localStorage.getItem(prefix)};
  },ownerAMarker);
  assert.ok(ownerARetryEnvelope.value,'owner A pending evaluation key is durable before authority reset');
  await race.context.clearCookies();
  await race.page.evaluate(()=>window.startApp());
  await race.page.locator('#scr5.on[data-access-state="no-session"]').waitFor({state:'visible'});
  await race.context.addCookies([{name:'eb_token',value:jwt.sign({u:'owner-b'},jwtSecret,{expiresIn:'1h'}),url:baseUrl,httpOnly:true,sameSite:'Lax'}]);
  assert.equal(await race.page.evaluate(()=>window.startApp()),true);await race.page.locator('#scr1.on').waitFor({state:'visible'});await openWriting(race.page);
  assert.equal(await race.page.locator('#w_editor').inputValue(),'','owner A draft text must not remain in owner B editor DOM');
  assert.equal(await race.page.evaluate(key=>localStorage.getItem(key),ownerARetryEnvelope.key),ownerARetryEnvelope.value,
    'ordinary authority reset preserves the owner-partitioned paid-call recovery envelope');
  assert.deepEqual(await race.page.evaluate(()=>({
    ringValue:document.getElementById('rv_ring').value,ringMax:document.getElementById('rv_ring').max,
    scope:document.getElementById('rv_scope_notice').textContent,scopeHidden:document.getElementById('rv_scope_notice').hidden,
    draftStatus:document.getElementById('w_draft_status').textContent,draftState:document.getElementById('w_draft_status').dataset.state||null,
    editorError:document.getElementById('w_editor_error').textContent,editorErrorHidden:document.getElementById('w_editor_error').hidden,
    resultHidden:document.getElementById('rv_result').hidden,errorHidden:document.getElementById('rv_error_state').hidden,
  })),{ringValue:0,ringMax:14,scope:'',scopeHidden:true,draftStatus:'Черновик сохраняется на этом устройстве',draftState:null,editorError:'',editorErrorHidden:true,resultHidden:true,errorHidden:true},'owner reset clears editor/review accessibility state and private scope');
  const ownerBBefore=await race.page.evaluate(()=>({owner:window.currentOwnerBinding().username,works:window.S.works?.length||0,essays:window.S.essays||0,generated:window.S.writeAi?.t38?.length||0}));
  lateTask.release();lateEvaluation.release();await race.page.waitForTimeout(350);
  assert.equal(ownerATaskRequests,1);assert.equal(ownerAEvaluations,1);
  assert.deepEqual(await race.page.evaluate(()=>({owner:window.currentOwnerBinding().username,works:window.S.works?.length||0,essays:window.S.essays||0,generated:window.S.writeAi?.t38?.length||0})),ownerBBefore,'late A task/evaluation responses cannot mutate owner B');
  assert.equal(await race.page.locator('#scr8.on').count(),1);assert.deepEqual(raceErrors,[]);await race.context.close();

  assert.ok(taskRequests.length>=1);assert.equal(taskRequests.every(request=>request.headers['x-easyboost-expected-owner']==='learner'),true);
  console.log('Aisy Writing Paper E2E passed: production build, phone matrix, dark/reduced, exact draft, atomic submit, failure, stale view and A→B owner guards');
}finally{
  if(browser)await browser.close();
  await stopProcess(child);
  if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
