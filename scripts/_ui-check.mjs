import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS || '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const base = 'http://localhost:8080/?now=2026-11-04T10:30';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const errors = [];
function watch(page, name) {
  page.on('pageerror', err => errors.push(`${name}: ${err.message}`));
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' && !/config\.local\.js/.test(t)) errors.push(`${name} console: ${t}`);
  });
}
async function shot(page, file) {
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: false });
}
async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
}
async function text(page) {
  return page.evaluate(() => document.body.innerText);
}

const phone = await browser.newPage();
watch(phone, 'phone');
await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await phone.goto(base + '#guide', { waitUntil: 'networkidle0' });
await phone.waitForSelector('h1');
let body = await text(phone);
if (!body.includes('Now / Next') || !body.includes('On now')) throw new Error('guide now missing\n' + body.slice(0, 400));
if (await overflow(phone)) throw new Error('guide overflows');
await shot(phone, 'mobile_guide_now.png');

await phone.click('button[data-seg="agenda"]');
await phone.waitForFunction(() => document.body.innerText.includes('sessions'));
if (await overflow(phone)) throw new Error('agenda overflows');
await shot(phone, 'mobile_agenda.png');

await phone.click('button[data-act="star"]');
await phone.$eval('button[data-act="star"]:not(.on)', el => el.scrollIntoView({ block: 'center' }));
await phone.click('button[data-act="star"]:not(.on)');
await phone.click('button[data-seg="starred"]');
await phone.waitForFunction(() => /Overlaps|starred item/.test(document.body.innerText));
body = await text(phone);
if (!/Overlaps/.test(body)) throw new Error('no conflict\n' + body.slice(0, 500));
await shot(phone, 'mobile_my_schedule.png');

await phone.click('#q');
await phone.type('#q', 'Audible');
await phone.waitForFunction(() => document.body.innerText.includes('Audible'));
if (await overflow(phone)) throw new Error('search overflows');
await shot(phone, 'mobile_search.png');
await phone.$eval('#q', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
await phone.waitForFunction(() => !document.body.innerText.includes('No matches') && document.querySelector('button[data-seg="food"]'));

await phone.click('button[data-seg="food"]');
await phone.waitForFunction(() => document.body.innerText.includes('Free entry'));
await phone.click('button[data-mode="comp"]');
await phone.waitForFunction(() => /complimentary|included/i.test(document.body.innerText));
await shot(phone, 'mobile_food.png');

await phone.click('button[data-seg="recruiters"]');
await phone.waitForFunction(() => document.body.innerText.includes('Booth'));
await shot(phone, 'mobile_recruiters.png');

await phone.click('a[href="#map"]');
await phone.waitForFunction(() => document.body.innerText.includes('Grand Lobby') || document.body.innerText.includes('Hall E'));
if (await overflow(phone)) throw new Error('map l1 overflows');
await shot(phone, 'mobile_map_l1.png');
await phone.click('button[data-level="2"]');
await phone.waitForFunction(() => document.body.innerText.includes('Avenida'));
await shot(phone, 'mobile_map_l2.png');
await phone.click('button[data-level="3"]');
await phone.waitForFunction(() => document.body.innerText.includes('Room 320'));
await shot(phone, 'mobile_map_l3.png');
await phone.click('button[data-level="none"]');
await phone.waitForFunction(() => document.body.innerText.includes('Coca-Cola') || document.body.innerText.includes('floor'));
await shot(phone, 'mobile_map_off.png');

await phone.goto(base + '#signin', { waitUntil: 'networkidle0' });
await phone.type('#name', 'Angel');
await phone.type('#code', 'test');
await phone.click('form[data-act="signin"] button');
await phone.waitForFunction(() => document.body.innerText.includes('Angel') && document.body.innerText.includes('Where are my friends'));
await shot(phone, 'mobile_friends.png');

await phone.click('a[href="#crew"]');
await phone.waitForFunction(() => document.body.innerText.includes('Create a pair link') || document.querySelector('.codebig'));
if (!(await phone.$('.codebig'))) {
  await phone.click('button[data-act="make-pair"]');
  await phone.waitForFunction(() => document.querySelector('.codebig'));
}
const code = await phone.$eval('.codebig', el => el.textContent.trim());
if (!/^[0-9a-f]{8}$/.test(code)) throw new Error('bad code ' + code);
await phone.$eval('#phone', el => { el.value = '+15555550123'; });
await phone.click('form[data-act="phone"] button');
await phone.waitForFunction(() => document.body.innerText.includes('Number saved'));
await shot(phone, 'mobile_crew.png');

const davidCtx = await browser.createBrowserContext();
const david = await davidCtx.newPage();
watch(david, 'david');
await david.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await david.goto(base + '#signin', { waitUntil: 'networkidle0' });
await david.type('#name', 'David');
await david.type('#code', 'test');
await david.click('form[data-act="signin"] button');
await david.waitForFunction(() => document.body.innerText.includes('Where are my friends'));
await david.click('a[href="#crew"]');
await david.waitForSelector('#pair-in');
await david.type('#pair-in', code);
await david.click('form[data-act="pair"] button');
await david.waitForFunction(() => document.body.innerText.includes('Paired with Angel'));
await david.reload({ waitUntil: 'networkidle0' });
await david.waitForFunction(() => document.body.innerText.includes('Call') && document.body.innerText.includes('Angel'));
const tel = await david.$eval('a[href^="tel:"]', a => a.getAttribute('href'));
if (tel !== 'tel:+15555550123') throw new Error('tel ' + tel);
const sms = await david.$eval('a[href^="sms:"]', a => a.getAttribute('href'));
if (!sms.startsWith('sms:')) throw new Error('sms ' + sms);
await shot(david, 'mobile_paired_call.png');

await david.click('a[href="#me"]');
await david.waitForSelector('button[data-act="set-level"][data-level="3"]');
await david.click('button[data-act="set-level"][data-level="3"]');
await david.waitForFunction(() => document.body.innerText.includes('Level 3, room not set'));
await shot(david, 'mobile_me.png');
await david.click('a[href="#map"]');
await david.waitForSelector('button[data-level="3"]');
await david.evaluate(() => document.querySelector('button[data-level="3"]').click());
await david.waitForFunction(() => document.body.innerText.includes('Level 3, room not set'));
await shot(david, 'mobile_checkin_on_map.png');

const desk = await browser.newPage();
watch(desk, 'desk');
await desk.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await desk.goto(base + '#guide', { waitUntil: 'networkidle0' });
await desk.click('button[data-seg="agenda"]');
await desk.waitForFunction(() => document.body.innerText.includes('sessions'));
const cols = await desk.$eval('.cards', el => getComputedStyle(el).gridTemplateColumns);
if (!cols.includes(' ')) throw new Error('desktop cards not 2 columns: ' + cols);
if (await overflow(desk)) throw new Error('desktop agenda overflows');
await shot(desk, 'desktop_agenda.png');
await desk.goto(base + '#map', { waitUntil: 'networkidle0' });
await desk.waitForSelector('svg');
if (await overflow(desk)) throw new Error('desktop map overflows');
await shot(desk, 'desktop_map.png');
await desk.click('button[data-level="3"]');
await desk.waitForFunction(() => document.body.innerText.includes('Room 350D') || document.body.innerText.includes('Ballroom'));
await shot(desk, 'desktop_map_l3.png');

if (errors.length) {
  console.log('PAGE ERRORS');
  console.log(errors.join('\n'));
  process.exitCode = 1;
} else console.log('ui checks passed', code);
await browser.close();
