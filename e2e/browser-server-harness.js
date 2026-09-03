import fs from 'node:fs/promises';
import net from 'node:net';
import jwt from 'jsonwebtoken';

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue through the standard browser locations.
    }
  }
  throw new Error('Chrome/Chromium executable was not found. Set CHROME_PATH.');
}

async function waitForReady(baseUrl, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early.\n${output.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) return;
    } catch {
      // The connection is expected to fail while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready.\n${output.join('')}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function createActiveSubscriptionPage(browser,{baseUrl,username,jwtSecret,contextOptions={}}){
  const context=await browser.newContext(contextOptions);
  /* Existing release scenarios model a returning authenticated learner. Keep that boundary
     explicit so the production first-launch gate does not turn unrelated shell tests into
     onboarding tests. Fresh first-launch coverage creates its own unseeded context. */
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('aisy.onboarding.completion')) {
        localStorage.setItem('aisy.onboarding.completion', JSON.stringify({
          version: 1, completedAt: '2026-08-26T00:00:00.000Z',
        }));
      }
    } catch {}
  });
  await context.addCookies([{
    name:'eb_token',
    value:jwt.sign({u:username},jwtSecret,{expiresIn:'1h'}),
    url:baseUrl,
    httpOnly:true,
    sameSite:'Lax',
  }]);
  const response=await context.request.get(`${baseUrl}/api/v1/me`);
  const session=await response.json().catch(()=>null);
  if(!response.ok()||session?.authenticated!==true||session?.username!==username||session?.active!==true){
    await context.close();
    throw new Error(`Server did not confirm active learning access for ${username}.`);
  }
  return{context,page:await context.newPage(),session};
}

async function openEgeHub(page) {
  if (!await page.locator('#aisy-ege.on').count()) {
    await page.locator('#aisy-shell-nav [data-destination="ege"]').press('Enter');
  }
  await page.locator('#aisy-ege.on').waitFor({ state: 'visible' });
}

async function openPracticeSkill(page, skill) {
  await page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Практика', exact: true }).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`.practice-row[data-skill="${skill}"] button`).press('Enter');
}

async function openEgeMock(page) {
  if (await page.locator('#scr16.on').count()) return;
  await openEgeHub(page);
  await page.waitForFunction(() => document.querySelectorAll('#ege-hub-sections > li').length === 5);
  const resume = page.getByRole('button', { name: 'Продолжить пробник' });
  if (await resume.count()) await resume.press('Enter');
  else await page.getByRole('button', { name: 'Открыть подготовку к пробнику' }).press('Enter');
  await page.locator('#scr16.on').waitFor({ state: 'visible' });
}

async function openLatestEgeResult(page) {
  if (await page.locator('#scr16.on').count()) return;
  await openEgeHub(page);
  await page.waitForFunction(() => document.querySelectorAll('#ege-hub-sections > li').length === 5);
  await page.getByRole('button', { name: /^Открыть результат:/u }).first().press('Enter');
  await page.locator('#scr16.on').waitFor({ state: 'visible' });
}

export {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openEgeHub, openEgeMock,
  openLatestEgeResult, openPracticeSkill, stopProcess, waitForReady,
};
