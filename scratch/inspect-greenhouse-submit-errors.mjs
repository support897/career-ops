import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
page.on('response', resp => {
  if (resp.status() >= 400 || resp.url().includes('submit') || resp.url().includes('jobs')) {
    console.log(`HTTP RESPONSE: ${resp.status()} ${resp.url()}`);
  }
});

console.log('Navigating to Greenhouse form...');
await page.goto('https://job-boards.greenhouse.io/playonsports/jobs/4340093009', { waitUntil: 'networkidle' });

await page.fill('#first_name', 'Ilse');
await page.fill('#last_name', 'Placencia');
await page.fill('#email', 'placenciailse@gmail.com');
await page.fill('#phone', '+61498570497');

await page.setInputFiles('#resume', 'output/cv.pdf');

const countryInput = await page.$('#country');
if (countryInput) {
  await countryInput.click();
  await countryInput.fill('Australia');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

const locInput = await page.$('#candidate-location');
if (locInput) {
  await locInput.click();
  await locInput.fill('Gold Coast');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

await page.fill('#question_6911685009', '70,000 AUD/year');

const spInput = await page.$('#question_6911686009');
if (spInput) {
  await spInput.click();
  await page.waitForTimeout(200);
  await spInput.fill('No');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

// Disarm hidden inputs
await page.evaluate(() => {
  document.querySelectorAll('input[aria-hidden="true"], input[tabindex="-1"]').forEach(el => {
    el.removeAttribute('required');
  });
});

console.log('Clicking Submit application button...');
const submitBtn = await page.$('#submit_app, button[type="submit"], input[type="submit"]');
if (submitBtn) {
  await submitBtn.click();
}

await page.waitForTimeout(5000);

const pageText = await page.evaluate(() => document.body.innerText);
console.log('--- BODY TEXT AFTER SUBMIT (first 500 chars) ---');
console.log(pageText.slice(0, 500));

await page.screenshot({ path: 'output/debug-post-submit-full.png', fullPage: true });

await browser.close();
