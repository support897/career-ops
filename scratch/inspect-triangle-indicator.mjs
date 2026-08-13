import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://job-boards.greenhouse.io/playonsports/jobs/4340093009', { waitUntil: 'networkidle' });

const indicators = await page.evaluate(() => {
  const els = document.querySelectorAll('.select__indicator, .select__dropdown-indicator, [class*="indicator"], svg, .select__control');
  return Array.from(els).map((el, i) => ({
    i,
    tagName: el.tagName,
    className: el.className,
    parentText: el.closest('.field-wrapper, label, div')?.textContent.slice(0, 100) || '',
    outerHTML: el.outerHTML.slice(0, 150)
  }));
});

console.log('DROPDOWN TRIANGLE INDICATORS:\n', JSON.stringify(indicators, null, 2));

await browser.close();
