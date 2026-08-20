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
const jwtSecret='aisy-shell-e2e-secret-at-least-32-chars';

let browser;
let child;
let temporaryDirectory;
try{
  temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'aisy-shell-e2e-'));
  const port=await availablePort();
  const baseUrl=`http://127.0.0.1:${port}`;
  const now=Date.now();
  const dataFile=path.join(temporaryDirectory,'data.json');
  await fs.writeFile(dataFile,JSON.stringify({
    users:{learner:{created:now,sub_until:now+86_400_000}},
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
    contextOptions:{viewport:{width:375,height:667},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  await mobile.page.goto(baseUrl,{waitUntil:'networkidle'});
  await mobile.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  const navigation=mobile.page.getByRole('navigation',{name:'Основные разделы'});
  await navigation.waitFor({state:'visible',timeout:5_000});
  const items=navigation.getByRole('button');
  assert.deepEqual(await items.allTextContents(),['Сегодня','Практика','ЕГЭ','Прогресс','Профиль']);
  assert.equal(await items.filter({hasText:'Сегодня'}).getAttribute('aria-current'),'page');

  await items.filter({hasText:'Практика'}).press('Enter');
  await mobile.page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:5_000});
  assert.equal(await items.filter({hasText:'Практика'}).getAttribute('aria-current'),'page');
  assert.equal(await navigation.locator('[aria-current="page"]').count(),1);
  assert.equal(
    await mobile.page.evaluate(()=>document.activeElement===document.querySelector('#aisy-practice main')),
    true,
    'keyboard navigation should move focus to the destination content',
  );

  await mobile.page.evaluate(()=>{
    document.getElementById('scr3').dataset.activeAttempt='preserved';
    window.nav('scr3');
  });
  await mobile.page.locator('#scr3.on').waitFor({state:'visible',timeout:5_000});
  const deepBack=mobile.page.getByRole('button',{name:'Назад в раздел Практика',exact:true});
  await deepBack.waitFor({state:'visible',timeout:5_000});
  assert.ok((await deepBack.boundingBox()).height>=44);
  const deepLayout=await mobile.page.evaluate(()=>{
    const back=document.getElementById('aisy-shell-back').getBoundingClientRect();
    const screen=document.getElementById('scr3').getBoundingClientRect();
    return{backBottom:back.bottom,screenTop:screen.top};
  });
  assert.ok(deepLayout.backBottom<=deepLayout.screenTop,'deep back bar must reserve its own header space');
  await deepBack.press('Enter');
  await mobile.page.locator('#aisy-practice.on').waitFor({state:'visible',timeout:5_000});
  assert.equal(await mobile.page.locator('#scr3').getAttribute('data-active-attempt'),'preserved');
  assert.equal(
    await mobile.page.evaluate(()=>document.activeElement===document.querySelector('#aisy-practice main')),
    true,
    'deep back should restore focus to the owning hub',
  );

  for(const viewport of [{width:320,height:568},{width:375,height:667},{width:768,height:1024}]){
    await mobile.page.setViewportSize(viewport);
    const layout=await mobile.page.evaluate(()=>{
      const frame=document.getElementById('frame').getBoundingClientRect();
      return{
        viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
        frameLeft:frame.left,frameRight:frame.right,
        controls:[...document.querySelectorAll('#aisy-shell-nav button')].map(button=>{
          const rect=button.getBoundingClientRect();return{width:rect.width,height:rect.height};
        }),
      };
    });
    assert.ok(layout.documentWidth<=layout.viewport,`horizontal overflow at ${viewport.width}px`);
    assert.ok(layout.frameLeft>=-0.5&&layout.frameRight<=layout.viewport+0.5);
    assert.equal(layout.controls.every(control=>control.width>=44&&control.height>=44),true);
  }
  await mobile.context.close();

  const desktop=await createActiveSubscriptionPage(browser,{
    baseUrl,username:'learner',jwtSecret,
    contextOptions:{viewport:{width:1440,height:900},reducedMotion:'reduce',serviceWorkers:'block'},
  });
  await desktop.page.goto(baseUrl,{waitUntil:'networkidle'});
  await desktop.page.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
  const desktopLayout=await desktop.page.evaluate(()=>{
    const frame=document.getElementById('frame').getBoundingClientRect();
    const nav=document.getElementById('aisy-shell-nav').getBoundingClientRect();
    return{
      viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
      frameWidth:frame.width,navWidth:nav.width,navHeight:nav.height,
      controls:[...document.querySelectorAll('#aisy-shell-nav button')].map(button=>{
        const rect=button.getBoundingClientRect();return{width:rect.width,height:rect.height};
      }),
    };
  });
  assert.ok(desktopLayout.documentWidth<=desktopLayout.viewport);
  assert.ok(desktopLayout.frameWidth<=720);
  assert.ok(desktopLayout.navHeight>desktopLayout.navWidth,'desktop navigation should adapt to a bounded rail');
  assert.equal(desktopLayout.controls.every(control=>control.width>=44&&control.height>=44),true);
  await desktop.context.close();
  console.log('Aisy learner shell Chromium E2E passed.');
}finally{
  if(browser)await browser.close();
  await stopProcess(child);
  if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
