import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {
  availablePort,chromeExecutable,createActiveSubscriptionPage,stopProcess,waitForReady,
} from './browser-server-harness.js';

const projectDirectory=fileURLToPath(new URL('..',import.meta.url));
const serverPath=fileURLToPath(new URL('../server.js',import.meta.url));
const jwtSecret='reading-listening-paper-e2e-secret-32-chars';
const requiredRegressionViewports=[
  {width:320,height:720,label:'320×720 regression'},
  {width:720,height:320,label:'720×320 regression'},
];
const literalResponsiveMatrix=[
  {width:320,height:768,label:'320 portrait'},
  {width:768,height:320,label:'320 landscape'},
  {width:375,height:812,label:'375 portrait'},
  {width:812,height:375,label:'375 landscape'},
  {width:768,height:1024,label:'768 portrait'},
  {width:1024,height:768,label:'768 landscape'},
  {width:1440,height:1920,label:'1440 portrait'},
  {width:1920,height:1440,label:'1440 landscape'},
];
const viewports=[...requiredRegressionViewports,...literalResponsiveMatrix];

async function openPractice(page){
  await page.getByRole('navigation',{name:'Основные разделы'}).getByRole('button',{name:'Практика'}).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:8_000});
  await page.locator('#practice-skills .practice-row').first().waitFor({state:'visible',timeout:8_000});
}

async function openSkill(page,skill,label){
  const row=page.locator(`.practice-row[data-skill="${skill}"]`);
  await row.getByRole('button',{name:new RegExp(`(?:Открыть|Продолжить): ${label}$`,'u')}).press('Enter');
}

async function paperMetrics(page,screenId,prefix){
  return page.evaluate(({screenId,prefix})=>{
    const screen=document.getElementById(screenId);
    const frame=document.getElementById('frame');
    const route=screen.querySelector('.learning-route');
    const area=document.getElementById(`${prefix}_area`);
    const dock=document.getElementById(`${prefix}_action_dock`);
    const primary=dock.querySelector('.learning-primary:not([hidden])');
    const progress=route.querySelector('.learning-route__progress');
    const rect=(element)=>element.getBoundingClientRect();
    const screenRect=rect(screen),frameRect=rect(frame),routeRect=rect(route),areaRect=rect(area),dockRect=rect(dock),ctaRect=rect(primary);
    const cta=getComputedStyle(primary),affordance=getComputedStyle(primary,'::after');
    const controls=[...screen.querySelectorAll('button,select'),document.getElementById('aisy-shell-back')]
      .filter(control=>control&&!control.hidden&&control.getClientRects().length)
      .map(control=>{const bounds=rect(control);return{label:control.getAttribute('aria-label')||control.textContent.trim(),width:bounds.width,height:bounds.height}});
    return{
      viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,
      frame:{width:frameRect.width,height:frameRect.height,computedHeight:getComputedStyle(frame).height,computedBlockSize:getComputedStyle(frame).blockSize},screen:{width:screenRect.width,height:screenRect.height,scrollWidth:screen.scrollWidth,clientWidth:screen.clientWidth,bottom:screenRect.bottom},
      route:{width:routeRect.width,height:routeRect.height,rows:getComputedStyle(route).gridTemplateRows},
      area:{height:areaRect.height,bottom:areaRect.bottom,scrollHeight:area.scrollHeight},
      dock:{top:dockRect.top,bottom:dockRect.bottom,height:dockRect.height},
      cta:{count:dock.querySelectorAll('.learning-primary').length,height:ctaRect.height,radius:cta.borderRadius,paddingLeft:cta.paddingLeft,paddingRight:cta.paddingRight,affordanceWidth:affordance.width,affordanceHeight:affordance.height},
      progress:{value:Number(progress.getAttribute('aria-valuenow')),label:progress.getAttribute('aria-label')},
      backVisible:document.querySelectorAll('#aisy-shell-back:not([hidden])').length,
      nav:{hidden:document.getElementById('aisy-shell-nav').hidden,inert:document.getElementById('aisy-shell-nav').inert},
      localNavVisible:[...screen.querySelectorAll('.navclay')].some(node=>node.getClientRects().length),
      controls,
    };
  },{screenId,prefix});
}

function assertPaperLayout(metrics,label){
  assert.ok(metrics.documentWidth<=metrics.viewport.width,`${label}: document overflow ${JSON.stringify(metrics)}`);
  assert.ok(metrics.documentHeight<=metrics.viewport.height,`${label}: document is taller than the viewport ${JSON.stringify(metrics)}`);
  assert.ok(metrics.frame.width<=390.5,`${label}: learner UI widened beyond phone canvas`);
  const expectedFrameHeight=Math.min(844,metrics.viewport.height);
  assert.equal(Math.round(metrics.frame.height),expectedFrameHeight,`${label}: frame must consume the current dynamic viewport height up to the 844px phone cap`);
  assert.equal(Math.round(Number.parseFloat(metrics.frame.computedHeight)),expectedFrameHeight,`${label}: computed height must resolve the final dvh override`);
  assert.equal(Math.round(Number.parseFloat(metrics.frame.computedBlockSize)),expectedFrameHeight,`${label}: computed block-size must resolve the final dvh override`);
  assert.ok(metrics.screen.scrollWidth<=metrics.screen.clientWidth+1,`${label}: screen overflow`);
  assert.ok(metrics.route.height>0&&metrics.area.height>0,`${label}: paper grid collapsed`);
  assert.ok(metrics.area.bottom<=metrics.dock.top+1,`${label}: dock occludes content ${JSON.stringify({viewport:metrics.viewport,screen:metrics.screen,route:metrics.route,area:metrics.area,dock:metrics.dock})}`);
  assert.ok(metrics.dock.bottom<=metrics.screen.bottom+1,`${label}: dock leaves deep route`);
  assert.ok(metrics.screen.bottom<=metrics.viewport.height+1&&metrics.dock.bottom<=metrics.viewport.height+1,`${label}: deep route leaves the visible viewport ${JSON.stringify(metrics)}`);
  assert.equal(metrics.cta.count,1,`${label}: expected one primary in the dock`);
  assert.equal(Number.isFinite(metrics.progress.value)&&metrics.progress.value>=0&&metrics.progress.value<=100,true,`${label}: invalid semantic progress`);
  assert.ok(metrics.progress.label,`${label}: progress needs an accessible name`);
  assert.equal(Math.round(metrics.cta.height),58,`${label}: CTA height`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.radius)),28,`${label}: CTA radius`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.paddingLeft)),26,`${label}: CTA left padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.paddingRight)),10,`${label}: CTA right padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.affordanceWidth)),38,`${label}: CTA affordance width`);
  assert.equal(Math.round(Number.parseFloat(metrics.cta.affordanceHeight)),38,`${label}: CTA affordance height`);
  assert.equal(metrics.backVisible,1,`${label}: canonical Back count`);
  assert.deepEqual(metrics.nav,{hidden:true,inert:true},`${label}: deep-route nav must be hidden and inert`);
  assert.equal(metrics.localNavVisible,false,`${label}: local navigation must stay absent`);
  assert.equal(metrics.controls.every(control=>control.width>=44&&control.height>=44),true,
    `${label}: undersized controls ${JSON.stringify(metrics.controls.filter(control=>control.width<44||control.height<44))}`);
}

async function assertResponsiveMatrix(page,screenId,prefix,state,{dialog=false}={}){
  for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.waitForFunction(expected=>Math.abs(document.getElementById('frame').getBoundingClientRect().height-expected)<1,
      Math.min(844,viewport.height),{timeout:2_000});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const label=`${state} · ${viewport.label}`;
    assertPaperLayout(await paperMetrics(page,screenId,prefix),label);
    if(dialog){
      const contained=await page.evaluate(screen=>{
        const route=document.querySelector(`#${screen} .learning-route`).getBoundingClientRect();
        const modal=document.querySelector(`#${screen} [role="dialog"]`).getBoundingClientRect();
        return modal.top>=route.top-1&&modal.bottom<=route.bottom+1&&modal.left>=route.left-1&&modal.right<=route.right+1;
      },screenId);
      assert.equal(contained,true,`${label}: blank-submit dialog must remain within the phone route`);
    }
  }
}

async function fillReadingTask10(page){
  const set=await page.evaluate(async()=>{
    const catalog=await window.EasyBoostReading.loadPilotCatalog();
    const id=window.S.readingPilot.history.lastSelected.task10.id;
    return catalog.sets.find(item=>item.id===id);
  });
  const fields=page.locator('[data-reading-kind="task10"] [data-reading-answer]');
  for(let index=0;index<set.task.answers.length;index+=1)await fields.nth(index).selectOption(String(set.task.answers[index]));
}

let browser;
let child;
let temporaryDirectory;
try{
  temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'reading-listening-paper-'));
  const port=await availablePort(),baseUrl=`http://127.0.0.1:${port}`,now=Date.now();
  const dataFile=path.join(temporaryDirectory,'data.json');
  await fs.writeFile(dataFile,JSON.stringify({
    users:{learner:{created:now,sub_until:now+86_400_000,privacy_consent:{text_processing:true,voice_processing:false,policy_version:'2026-08-26-vk-id-v1',updated_at:new Date(now).toISOString()}}},
    progress:{learner:{}},
  }),'utf8');
  const output=[];
  child=spawn(process.execPath,[serverPath],{cwd:projectDirectory,env:{
    ...process.env,NODE_ENV:'test',PORT:String(port),APP_URL:baseUrl,DATABASE_PROVIDER:'file',DATA_FILE:dataFile,JWT_SECRET:jwtSecret,
    TELEGRAM_BOT_TOKEN:'',ADMIN_TELEGRAM_ID:'',XAI_ENABLED:'false',VOICE_TUTOR_ENABLED:'false',ADAPTIVE_LEARNING_ENABLED:'false',
  },stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output.push(chunk.toString()));child.stderr.on('data',chunk=>output.push(chunk.toString()));
  await waitForReady(baseUrl,child,output);
  browser=await chromium.launch({headless:true,executablePath:await chromeExecutable()});
  const session=await createActiveSubscriptionPage(browser,{baseUrl,username:'learner',jwtSecret,contextOptions:{viewport:{width:viewports[0].width,height:viewports[0].height},reducedMotion:'reduce',colorScheme:'light',serviceWorkers:'block'}});
  const {context,page}=session,errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(baseUrl,{waitUntil:'networkidle'});await page.locator('#scr1.on').waitFor({state:'visible',timeout:8_000});await openPractice(page);

  await openSkill(page,'reading','Чтение');await page.locator('#scr7.on .reading-hub').waitFor({state:'visible',timeout:8_000});
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  assert.deepEqual(await page.locator('#scr7 .learning-view-enter').evaluate(node=>{const style=getComputedStyle(node);return{animationName:style.animationName,animationDuration:style.animationDuration,transform:style.transform}}),{animationName:'learning-paper-fade',animationDuration:'0.08s',transform:'none'},'reduced motion replaces the spatial shift with an 80ms fade');
  assert.deepEqual(await page.evaluate(()=>{const spinner=document.createElement('span');spinner.className='reading-spinner';document.body.append(spinner);const style=getComputedStyle(spinner),result={animationName:style.animationName,transform:style.transform};spinner.remove();return result}),{animationName:'none',transform:'none'},'reduced motion removes spatial loading animation');
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.deepEqual(await page.locator('#scr7 .learning-view-enter').evaluate(node=>{const style=getComputedStyle(node);return{animationName:style.animationName,animationDuration:style.animationDuration}}),{animationName:'learning-paper-enter',animationDuration:'0.38s'},'normal mode uses one restrained 380ms paper-layer shift');
  assert.deepEqual(await page.locator('#scr7 .learning-view-enter').evaluate(node=>{const animation=node.getAnimations().find(item=>item.animationName==='learning-paper-enter');animation.currentTime=0;const matrix=new DOMMatrix(getComputedStyle(node).transform);animation.finish();return{x:Math.round(matrix.m41),y:Math.round(matrix.m42)}}),{x:16,y:0},'Direction A paper sheet settles horizontally from the right by 16px');
  {const cta=page.locator('#r_action_dock .learning-primary'),box=await cta.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(220);
    const pressed=await cta.evaluate(node=>{const style=getComputedStyle(node),matrix=new DOMMatrix(style.transform);return{y:Math.round(matrix.m42),durations:style.transitionDuration}});assert.equal(pressed.y,2,'primary press feedback settles by 2px');assert.match(pressed.durations,/(?:0\.18s|180ms)/u);await page.mouse.move(0,0);await page.mouse.up();}
  await page.emulateMedia({reducedMotion:'reduce'});
  await assertResponsiveMatrix(page,'scr7','r','Reading hub');
  const lightBackground=await page.locator('#scr7 .learning-route').evaluate(node=>getComputedStyle(node).backgroundColor);
  await page.evaluate(()=>window.AisyTheme.set('dark'));
  await page.waitForFunction(previous=>getComputedStyle(document.querySelector('#scr7 .learning-route')).backgroundColor!==previous,lightBackground);
  const darkState=await page.locator('#scr7 .learning-route').evaluate(node=>({
    background:getComputedStyle(node).backgroundColor,
    colorScheme:getComputedStyle(node).colorScheme,
    rootTheme:document.documentElement.dataset.theme,
    semanticBackground:getComputedStyle(document.documentElement).getPropertyValue('--aisy-color-background'),
    supportsLightDark:CSS.supports('color','light-dark(white, black)'),
  }));
  assert.notEqual(darkState.background,lightBackground,`Reading dark mode must consume semantic theme tokens: ${JSON.stringify(darkState)}`);
  await page.evaluate(()=>window.AisyTheme.set('light'));await page.setViewportSize({width:viewports[0].width,height:viewports[0].height});

  await page.evaluate(async()=>{
    const catalog=await window.EasyBoostReading.loadPilotCatalog();
    const words=JSON.stringify(catalog).match(/[A-Za-z][A-Za-z'-]*/g)||[];
    window.S.wstatus=window.S.wstatus||{};
    words.forEach(word=>{window.S.wstatus[word.toLowerCase()]='learn'});
  });
  await page.emulateMedia({reducedMotion:'no-preference'});
  const startReading=page.getByRole('button',{name:/^Начать Task 10/u});await startReading.focus();await page.locator('#r_area').evaluate(node=>{node.scrollTop=node.scrollHeight});await page.keyboard.press('Enter');
  assert.equal(await page.locator('#scr7 .reading-practice').evaluate(node=>getComputedStyle(node).animationName),'learning-paper-enter','Reading task transition uses the approved paper motion');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr7 .reading-practice')!==null),true,'Reading task transition moves keyboard focus into the new view');
  assert.equal(await page.evaluate(()=>{const area=document.getElementById('r_area'),heading=area.querySelector('.learning-view-title'),a=area.getBoundingClientRect(),h=heading.getBoundingClientRect();return area.scrollTop===0&&h.top>=a.top-1&&h.bottom<=a.bottom+1}),true,'Reading task heading is visible after launching from a scrolled hub');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#scr7 .reading-text .iconbtn').first().waitFor({state:'visible'});
  await page.evaluate(()=>window.AisyTheme.set('dark'));
  const highlightedWord=await page.locator('#scr7 .reading-word--learning').first().evaluate(node=>{
    const parse=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
    const luminance=value=>{
      const channels=parse(value).map(channel=>{const normalized=channel/255;return normalized<=.04045?normalized/12.92:((normalized+.055)/1.055)**2.4});
      return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
    };
    const style=getComputedStyle(node),foreground=luminance(style.color),background=luminance(style.backgroundColor);
    return{ratio:(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05),label:node.getAttribute('aria-label'),state:node.dataset.wordState};
  });
  assert.equal(highlightedWord.state,'learn');assert.match(highlightedWord.label,/в изучении/u);assert.ok(highlightedWord.ratio>=4.5,`dark Reading word highlight contrast ${highlightedWord.ratio}`);
  await assertResponsiveMatrix(page,'scr7','r','Reading Task 10 task');
  await page.setViewportSize({width:320,height:720});
  assert.equal(await page.locator('#scr7 .reading-text .iconbtn').first().evaluate(node=>{const rect=node.getBoundingClientRect();return rect.width>=44&&rect.height>=44}),true,'Reading word controls expose a genuine 44px minimum tap box');
  const wordTrigger=page.locator('#scr7 .reading-word').first();
  await wordTrigger.focus();
  const triggerWord=await wordTrigger.getAttribute('data-w');
  await wordTrigger.press('Enter');
  const wordPopover=page.locator('#r_pop');
  await wordPopover.waitFor({state:'visible'});
  const popoverA11y=await wordPopover.evaluate(node=>({
    tag:node.tagName,open:node.open,role:node.getAttribute('role'),modal:node.getAttribute('aria-modal'),labelledby:node.getAttribute('aria-labelledby'),
    describedby:node.getAttribute('aria-describedby'),active:document.activeElement?.id,
    controls:[...node.querySelectorAll('button')].map(control=>{const rect=control.getBoundingClientRect();return{name:control.getAttribute('aria-label')||control.textContent.trim(),width:rect.width,height:rect.height}}),
  }));
  assert.deepEqual({tag:popoverA11y.tag,open:popoverA11y.open,role:popoverA11y.role,modal:popoverA11y.modal,labelledby:popoverA11y.labelledby,describedby:popoverA11y.describedby,active:popoverA11y.active},
    {tag:'DIALOG',open:true,role:'dialog',modal:'true',labelledby:'r_word',describedby:'r_tr',active:'r_pop'},'word lookup must announce and receive focus as one native modal dialog');
  assert.deepEqual(popoverA11y.controls.filter(control=>control.width<44||control.height<44),[],
    `word popover controls below 44px: ${JSON.stringify(popoverA11y.controls)}`);
  const darkPopover=await wordPopover.evaluate(node=>{
    const resolve=token=>{const probe=document.createElement('span');probe.style.color=`var(${token})`;document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value};
    const style=getComputedStyle(node),word=getComputedStyle(node.querySelector('#r_word')),
      speak=getComputedStyle(node.querySelector('.reading-word-popover__icon--speak')),
      close=getComputedStyle(node.querySelector('.reading-word-popover__icon--close')),
      learn=getComputedStyle(node.querySelector('.reading-word-popover__action--learn')),
      known=getComputedStyle(node.querySelector('.reading-word-popover__action--known'));
    return{
      rootTheme:document.documentElement.dataset.theme,colorScheme:style.colorScheme,
      computed:{surface:style.backgroundColor,text:word.color,speakSurface:speak.backgroundColor,speakText:speak.color,
        closeSurface:close.backgroundColor,closeText:close.color,learnSurface:learn.backgroundColor,learnText:learn.color,
        knownSurface:known.backgroundColor,knownText:known.color},
      tokens:{surface:resolve('--aisy-primitive-night-surface-raised'),text:resolve('--aisy-primitive-night-text'),
        speakSurface:resolve('--aisy-primitive-warning-soft-dark'),speakText:resolve('--aisy-primitive-warning-dark'),
        closeSurface:resolve('--aisy-primitive-night-surface-muted'),closeText:resolve('--aisy-primitive-night-text-muted'),
        learnSurface:resolve('--aisy-primitive-night-surface'),learnText:resolve('--aisy-primitive-focus-dark'),
        knownSurface:resolve('--aisy-primitive-success-soft-dark'),knownText:resolve('--aisy-primitive-success-dark')},
    };
  });
  assert.equal(darkPopover.rootTheme,'dark','opening the word popover must preserve the forced dark preference');
  assert.match(darkPopover.colorScheme,/dark/u);
  assert.deepEqual(darkPopover.computed,darkPopover.tokens,
    `word popover must resolve every surface/text/control pair to warm dark tokens: ${JSON.stringify(darkPopover)}`);
  await wordTrigger.evaluate(node=>node.focus());
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#r_pop')!==null),true,
    'showModal keeps the Reading route inert while the word dialog is open');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>{
    const controls=[...document.querySelectorAll('#r_pop button:not([disabled])')].filter(control=>control.getClientRects().length>0);
    return document.activeElement===controls.at(-1);
  }),true,
    'reverse Tab from the dialog entry must stay on the last enabled control');
  await page.keyboard.press('Escape');
  await wordPopover.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(word=>document.activeElement?.dataset.w===word,triggerWord),true,
    'Escape must close the word popover and restore its exact trigger');
  await page.evaluate(()=>window.AisyTheme.set('light'));
  const submitTraining=page.locator('#r_action_dock [data-reading-action="submit-training"]');
  assert.equal(await submitTraining.isDisabled(),true,'Reading submit stays truly disabled before a complete selection');
  await page.locator('[data-reading-kind="task10"] [data-reading-answer]').first().selectOption('0');
  assert.deepEqual(await page.evaluate(()=>({kind:document.activeElement?.dataset.kind,position:document.activeElement?.dataset.position})),{kind:'task10',position:'0'},'Reading restores focus for answer index 0');
  assert.equal(await page.locator('#scr7 .learning-route__progress').getAttribute('aria-valuenow'),'14');
  await fillReadingTask10(page);assert.equal(await page.locator('#scr7 .learning-route__progress').getAttribute('aria-valuenow'),'100');assert.equal(await submitTraining.isDisabled(),false);
  await page.emulateMedia({reducedMotion:'no-preference'});await submitTraining.press('Enter');
  await page.locator('[data-reading-review-row]').first().waitFor({state:'visible',timeout:8_000});
  assert.equal(await page.locator('#scr7 .reading-result').evaluate(node=>getComputedStyle(node).animationName),'learning-paper-enter','Reading review transition uses the approved paper motion');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr7 .reading-result')!==null),true,'Reading review transition moves keyboard focus into the new view');
  await page.emulateMedia({reducedMotion:'reduce'});
  await assertResponsiveMatrix(page,'scr7','r','Reading Task 10 review');
  await page.setViewportSize({width:320,height:720});
  assert.match(await page.locator('[data-reading-review-row]').first().innerText(),/Верно|Ошибка/u);
  assert.equal(await page.locator('#r_action_dock .learning-primary').innerText(),'Следующий комплект');
  await page.getByRole('button',{name:'К каталогу',exact:true}).press('Enter');

  await page.locator('#r_action_dock [data-reading-action="full-intro"]').press('Enter');
  await page.locator('#r_action_dock [data-reading-action="start-full"]').press('Enter');
  await page.setViewportSize({width:1440,height:900});
  assert.equal(await page.locator('#scr7 .reading-overview section > div').evaluateAll(groups=>groups.every(group=>group.scrollWidth<=group.clientWidth+1)),true,'fixed phone canvas keeps the four-column full overview inside its cards at desktop viewport');
  await page.setViewportSize({width:320,height:720});
  await page.locator('#r_action_dock [data-reading-action="full-kind"][data-kind="task11"]').press('Enter');
  await page.locator('#r_action_dock [data-reading-action="full-kind"][data-kind="task12_18"]').press('Enter');
  const longPassageTypography=await page.locator('#scr7 .reading-passage.reading-text').evaluate(node=>{
    const words=[...node.querySelectorAll('.reading-word')],rows=new Set(words.map(word=>Math.round(word.getBoundingClientRect().top)));const style=getComputedStyle(words[0]);
    return{paddingInlineStart:style.paddingInlineStart,paddingInlineEnd:style.paddingInlineEnd,words:words.length,rows:rows.size,overflow:node.scrollWidth>node.clientWidth+1};
  });
  assert.deepEqual({start:longPassageTypography.paddingInlineStart,end:longPassageTypography.paddingInlineEnd,overflow:longPassageTypography.overflow},{start:'0px',end:'0px',overflow:false},'long Reading passage keeps natural word spacing and no horizontal overflow');
  assert.ok(longPassageTypography.words/longPassageTypography.rows>=2.5,`long Reading passage became too sparse: ${JSON.stringify(longPassageTypography)}`);
  await assertResponsiveMatrix(page,'scr7','r','Reading full-section long task');
  await page.setViewportSize({width:320,height:720});
  const submitFull=page.locator('#r_action_dock [data-reading-action="submit-full"]');
  await submitFull.focus();await submitFull.press('Enter');
  const dialog=page.getByRole('dialog',{name:'В ответах есть пропуски'});await dialog.waitFor({state:'visible'});
  const cancel=dialog.getByRole('button',{name:'Вернуться к ответам'}),confirm=dialog.getByRole('button',{name:'Сдать с пропусками'});
  await assertResponsiveMatrix(page,'scr7','r','Reading blank-submit modal',{dialog:true});
  await page.setViewportSize({width:320,height:720});
  assert.equal(await cancel.evaluate(node=>document.activeElement===node),true);
  await cancel.press('Shift+Tab');assert.equal(await confirm.evaluate(node=>document.activeElement===node),true,'Shift+Tab wraps to the last modal control');
  await confirm.press('Tab');assert.equal(await cancel.evaluate(node=>document.activeElement===node),true,'Tab wraps to the first modal control');
  await cancel.press('Escape');assert.equal(await dialog.isVisible(),false);assert.equal(await submitFull.evaluate(node=>document.activeElement===node),true,'Escape returns exact submit focus');
  await submitFull.press('Enter');await dialog.waitFor({state:'visible'});
  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await openSkill(page,'reading','Чтение');await page.locator('#scr7.on .reading-full').waitFor({state:'visible',timeout:8_000});
  assert.equal(await page.locator('#scr7 [data-reading-dialog]').count(),1,'route re-entry owns one dialog instance');
  assert.equal(await page.locator('#scr7 [data-reading-dialog]').isHidden(),true,'route-away closes the portalled dialog');
  assert.equal(await page.locator('#scr7 .learning-route > [inert]').count(),0,'route-away clears modal inert state before re-entry');

  const nonFirstFullAnswer=page.locator('[data-reading-kind="task12_18"] [data-reading-answer][data-position="0"]').nth(2);await nonFirstFullAnswer.focus();await nonFirstFullAnswer.press('Space');
  assert.deepEqual(await page.evaluate(()=>({value:document.activeElement?.value,checked:document.activeElement?.checked})),{value:'2',checked:true},'Reading rerender restores the selected non-first radio');
  const fullBefore=await page.evaluate(()=>({id:window.RE.attempt.id,kind:window.RE.attempt.currentKind,position:window.RE.attempt.currentPosition,answers:structuredClone(window.RE.attempt.answers)}));
  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');await page.waitForTimeout(300);
  const pausedDuration=await page.evaluate(()=>window.RE.attempt.durationMs);
  await openSkill(page,'reading','Чтение');await page.locator('#scr7.on .reading-full').waitFor({state:'visible',timeout:8_000});
  const fullAfter=await page.evaluate(()=>({id:window.RE.attempt.id,kind:window.RE.attempt.currentKind,position:window.RE.attempt.currentPosition,answers:structuredClone(window.RE.attempt.answers),durationMs:window.RE.attempt.durationMs,resumedAt:window.RE.resumedAt}));
  assert.deepEqual({id:fullAfter.id,kind:fullAfter.kind,position:fullAfter.position,answers:fullAfter.answers},fullBefore,'Reading resumes exact attempt/phase/selections including index 0');
  assert.equal(fullAfter.durationMs,pausedDuration,'hub time does not enter Reading elapsed duration');assert.ok(fullAfter.resumedAt>0);

  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');
  await openSkill(page,'listening','Аудирование');await page.locator('#scr4.on .listening-launch-grid').waitFor({state:'visible',timeout:8_000});
  await assertResponsiveMatrix(page,'scr4','l','Listening hub');
  await page.setViewportSize({width:viewports[0].width,height:viewports[0].height});await page.evaluate(()=>window.AisyTheme.set('dark'));
  await page.waitForFunction(previous=>getComputedStyle(document.querySelector('#scr4 .learning-route')).backgroundColor!==previous,lightBackground);
  assert.notEqual(await page.locator('#scr4 .learning-route').evaluate(node=>getComputedStyle(node).backgroundColor),lightBackground);
  await page.evaluate(()=>window.AisyTheme.set('light'));

  const startListening=page.getByRole('button',{name:/^Соответствия/u});await startListening.focus();await page.locator('#l_area').evaluate(node=>{node.scrollTop=node.scrollHeight});await page.keyboard.press('Enter');
  assert.equal(await page.locator('#scr4 .listening-view').evaluate(node=>getComputedStyle(node).animationName),'learning-paper-fade','Listening task transition respects reduced motion');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr4 .listening-view')!==null),true,'Listening task transition moves keyboard focus into the new view');
  assert.equal(await page.evaluate(()=>{const area=document.getElementById('l_area'),heading=area.querySelector('.learning-view-title'),a=area.getBoundingClientRect(),h=heading.getBoundingClientRect();return area.scrollTop===0&&h.top>=a.top-1&&h.bottom<=a.bottom+1}),true,'Listening task heading is visible after launching from a scrolled hub');
  await assertResponsiveMatrix(page,'scr4','l','Listening matching task with audio');
  await page.setViewportSize({width:320,height:720});
  const submitListening=page.locator('#l_action_dock .learning-primary');assert.equal(await submitListening.isDisabled(),true);
  assert.equal(await page.locator('#scr4 .listening-audio').evaluate(node=>{const controls=[...node.querySelectorAll('.listening-audio__stop,.listening-audio__pause,.listening-audio__slow')].map(control=>control.getBoundingClientRect());return controls.every((rect,index)=>rect.width>=44&&rect.height>=44&&(index===0||rect.left>=controls[index-1].right-1))}),true,'320px audio controls keep three non-overlapping 44px transport columns');
  {const group=page.locator('.listening-choice-list[role="radiogroup"]').first(),radios=group.getByRole('radio');await radios.nth(0).focus();await radios.nth(0).press('ArrowRight');
    assert.equal(await radios.nth(1).getAttribute('aria-checked'),'true');
    assert.equal(await radios.nth(1).evaluate(node=>document.activeElement===node),true,'ArrowRight moves focus with selection');
    assert.equal(await group.locator('[role="radio"]:not(:disabled)[tabindex="0"]').count(),1,'radiogroup has one roving tab stop');}
  for(let index=0;index<6;index+=1){const choice=page.getByRole('radio',{name:`Говорящий ${String.fromCharCode(65+index)}, утверждение ${index+1}`});await choice.focus();await choice.press('Space')}
  assert.equal(await page.locator('#scr4 .learning-route__progress').getAttribute('aria-valuenow'),'100');
  assert.equal(await submitListening.isDisabled(),false);await submitListening.press('Enter');
  await page.locator('.listening-answer-state').first().waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr4 .listening-view')!==null),true,'Listening review transition moves keyboard focus into the new view');
  await assertResponsiveMatrix(page,'scr4','l','Listening matching review and transcript');
  await page.setViewportSize({width:320,height:720});
  await page.locator('#scr4 .listening-transcript__line .iconbtn').first().waitFor({state:'visible'});
  assert.equal(await page.locator('#scr4 .listening-transcript__line .iconbtn').first().evaluate(node=>{const rect=node.getBoundingClientRect();return rect.width>=44&&rect.height>=44}),true,'Listening transcript word controls expose a genuine 44px minimum tap box');
  assert.match(await page.locator('.listening-answer-state').first().innerText(),/Верно|Ошибка/u);
  assert.equal(await page.locator('#scr4 .listening-choice:disabled').count()>0,true,'submitted Listening radios are truly disabled');
  assert.equal(await page.locator('#l_action_dock .learning-primary').innerText(),'Следующий комплект');
  await page.getByRole('button',{name:'К каталогу',exact:true}).press('Enter');

  await page.locator('#l_action_dock .learning-primary').press('Enter');await page.getByRole('heading',{name:'Раздел «Аудирование» целиком'}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr4 .listening-view')!==null),true,'Listening exam intro owns focus after the catalog CTA');
  await page.locator('#l_action_dock .learning-primary').press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr4 .listening-view')!==null),true,'Listening exam start owns focus after replacing its CTA');
  assert.deepEqual(await page.locator('#l_today').evaluate(node=>({role:node.getAttribute('role'),live:node.getAttribute('aria-live')})),{role:'timer',live:'off'},'running exam timer is non-live');
  for(let index=0;index<6;index+=1){const choice=page.getByRole('radio',{name:`Говорящий ${String.fromCharCode(65+index)}, утверждение ${index+1}`});await choice.focus();await choice.press('Space')}
  const examStageNext=page.locator('#l_action_dock .learning-primary');assert.equal(await examStageNext.innerText(),'Дальше: этап 2');assert.equal(await examStageNext.isDisabled(),false);await examStageNext.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#scr4 .listening-view')!==null),true,'Listening stage Next moves focus into the replacement stage');
  {const choice=page.locator('#scr4 .listening-choice-list[role="radiogroup"]').first().getByRole('radio').first();await choice.focus();await choice.press('Space')}
  assert.equal(await page.locator('#scr4 .learning-route__progress').getAttribute('aria-valuenow'),'38');
  const listeningBefore=await page.evaluate(()=>({stage:window.LE.stage,selections:window.LE.selM.slice(),trueFalse:window.LE.selT.slice(),startedAt:window.LE.t0,plays:window.LE.plays.slice()}));
  await page.getByRole('button',{name:'Назад в раздел Практика',exact:true}).press('Enter');await page.waitForTimeout(300);
  const pausedAt=await page.evaluate(()=>window.LE.pausedAt);assert.ok(Number.isFinite(pausedAt));
  await openSkill(page,'listening','Аудирование');await page.locator('#scr4 .listening-choice-list[role="radiogroup"]').first().getByRole('radio').first().waitFor({state:'visible',timeout:8_000});
  const listeningAfter=await page.evaluate(()=>({stage:window.LE.stage,selections:window.LE.selM.slice(),trueFalse:window.LE.selT.slice(),startedAt:window.LE.t0,plays:window.LE.plays.slice(),pausedAt:window.LE.pausedAt,interval:Boolean(window.LE.iv)}));
  assert.deepEqual({stage:listeningAfter.stage,selections:listeningAfter.selections,trueFalse:listeningAfter.trueFalse,plays:listeningAfter.plays},{stage:listeningBefore.stage,selections:listeningBefore.selections,trueFalse:listeningBefore.trueFalse,plays:listeningBefore.plays},'Listening resumes exact stage/selections/play counters');
  assert.ok(listeningAfter.startedAt>=listeningBefore.startedAt+250,'Listening excludes paused hub time');assert.equal(listeningAfter.pausedAt,null);assert.equal(listeningAfter.interval,true);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('Reading/Listening Paper A production Chromium matrix passed.');
}finally{
  if(browser)await browser.close();await stopProcess(child);
  if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
