import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ui/node_modules/playwright-core/index.mjs';
import sharp from '../../../mcp/node_modules/sharp/dist/index.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const session = JSON.parse(readFileSync(`${root}.odos/s3c2c2a2/browser-session.json`, 'utf8'));
export const browser = await chromium.launch({ channel: 'chrome', headless: true });
export const context = await browser.newContext({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 1 });
await context.addInitScript(({token}) => sessionStorage.setItem('odos.session.v1', JSON.stringify({accessToken:token, expiresAt:Date.now()+3600000})), {token:session.providerToken});
export const page = await context.newPage();
let adminUpload = true;
export function uploadAsAdmin(value) { adminUpload = value; }
export const captures = [];
await page.route('**/clinical-graph/imaging', async route => {
  if (route.request().method() === 'POST' && adminUpload) {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${session.uploadToken}` } });
  } else await route.continue();
});
page.on('response', response => {
  if (response.request().method() === 'POST' && response.url().endsWith('/clinical-graph/imaging')) captures.push({status:response.status(), caller:adminUpload?'project-admin':'provider'});
});
export const jpeg = await sharp({create:{width:800,height:500,channels:3,background:{r:235,g:235,b:235}}}).jpeg().toBuffer();
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];
let pdfText='%PDF-1.4\n', offsets=[0];
for (const [i,object] of objects.entries()) { offsets.push(Buffer.byteLength(pdfText)); pdfText+=`${i+1} 0 obj\n${object}\nendobj\n`; }
const xref=Buffer.byteLength(pdfText);
pdfText+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
export const pdf=Buffer.from(pdfText);
export async function open() { await page.goto(`http://127.0.0.1:15122/clinic?patientId=${session.patientId}&encounterId=${session.encounterId}`, {waitUntil:'networkidle'}); }
export async function shot(name) { await page.screenshot({path:`${root}docs/build-log/followup-s3c2c2a2-result-ui/${name}.png`,animations:'disabled'}); }
export function queue() { return page.getByRole('region',{name:'Tests for today',exact:true}); }
export function row(label) { return queue().locator(':scope > ul > li').filter({has:page.getByRole('heading',{name:label,exact:true})}); }
export async function followup() { await page.getByRole('tab',{name:'Follow-up',exact:true}).filter({visible:true}).first().click(); await queue().getByRole('heading',{name:'Tests for today'}).waitFor(); }
export async function submitManualImaging() {
  const response = page.waitForResponse(value => value.url().endsWith('/clinical-graph/imaging') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'Upload to chart', exact: true }).click();
  return response;
}
