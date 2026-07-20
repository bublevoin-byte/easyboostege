import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SELF='scripts/scan-secrets.js';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const rules=[
  ['private key',new RegExp('-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----','u')],
  ['OpenAI-style key',new RegExp('s'+'k-[A-Za-z0-9_-]{32,}','u')],
  ['GitHub token',new RegExp('gh'+'[pousr]_[A-Za-z0-9]{30,}','u')],
  ['Telegram bot token',new RegExp('\\b\\d{8,12}:[A-Za-z0-9_-]{30,}\\b','u')],
];
const findings=[];
for(const file of files){
  if(file===SELF||file.endsWith('.png')||file.endsWith('.dump')||file.endsWith('.gz'))continue;
  let content='';try{content=fs.readFileSync(file,'utf8')}catch(_){continue}
  for(const [name,pattern] of rules)if(pattern.test(content))findings.push(`${file}: ${name}`);
}
if(findings.length){console.error(`Secret scan failed:\n${findings.join('\n')}`);process.exit(1)}
console.log(`Secret scan passed (${files.length} tracked files checked).`);
