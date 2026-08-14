/**
 * linkedin.mjs — LinkedIn job provider using Puppeteer Stealth (headless)
 * 
 * Uses puppeteer-extra with stealth plugin to bypass LinkedIn's bot detection.
 * Runs completely in background — no browser window, no user interaction.
 * 
 * Cookie expiration triggers email notification.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import nodemailer from 'nodemailer';

puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../config/linkedin.yml');
const EMAIL_CONFIG_PATH = join(__dirname, '../config/email.yml');
const CHROME_PATH = process.env.CHROME_PATH
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium'
  : existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
  : existsSync('/ms-playwright/chromium-1228/chrome-linux/chrome') ? '/ms-playwright/chromium-1228/chrome-linux/chrome'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

// ─── Cookie loading ────────────────────────────────────────────────────────

async function loadCookies(userId) {
  // Try DB first if userId provided
  if (userId) {
    try {
      const { getUserCookies } = await import('../lib/db-reader.mjs');
      const { decryptCookies } = await import('../lib/cookie-crypto.mjs');
      const row = await getUserCookies(userId, 'linkedin');
      if (row?.encrypted) {
        const cookies = decryptCookies(userId, row.encrypted);
        if (cookies && cookies.length > 0) {
          console.log(`[linkedin] Loaded ${cookies.length} cookies from DB for user ${userId.slice(0, 12)}...`);
          return { cookies, exportedAt: row.exportedAt, source: 'db' };
        }
      }
    } catch (e) {
      console.warn(`[linkedin] DB cookie load failed, falling back to file: ${e.message}`);
    }
  }

  // Fallback to local YAML file
  if (!existsSync(CONFIG_PATH)) return null;
  
  const yaml = readFileSync(CONFIG_PATH, 'utf8');
  const cookies = [];
  
  const cookieRegex = /- name:\s*"([^"]+)"\s*\n\s*value:\s*"([^"]+)"/g;
  let match;
  while ((match = cookieRegex.exec(yaml)) !== null) {
    cookies.push({ name: match[1], value: match[2], domain: '.linkedin.com' });
  }
  
  const exportedMatch = yaml.match(/exportedAt:\s*"([^"]+)"/);
  const exportedAt = exportedMatch?.[1] ? new Date(exportedMatch[1]) : null;
  
  return { cookies, exportedAt, source: 'file' };
}

function checkCookieAge(exportedAt) {
  if (!exportedAt) return { valid: false, days: -1 };
  
  const age = Date.now() - exportedAt.getTime();
  const days = Math.round(age / (24 * 60 * 60 * 1000));
  
  return { valid: days < 30, days };
}

// ─── Expiration email ──────────────────────────────────────────────────────

async function sendExpirationEmail() {
  try {
    if (!existsSync(EMAIL_CONFIG_PATH)) return;
    
    const emailConfig = readFileSync(EMAIL_CONFIG_PATH, 'utf8');
    const userMatch = emailConfig.match(/user:\s*"([^"]+)"/);
    const passMatch = emailConfig.match(/app_password:\s*"([^"]+)"/);
    
    if (!userMatch || !passMatch) return;
    
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: userMatch[1],
        pass: passMatch[1],
      },
    });
    
    await transporter.sendMail({
      from: `"Career-Ops" <${userMatch[1]}>`,
      to: userMatch[1],
      subject: '[Career-Ops] LinkedIn Cookies Expired — Please Re-login',
      html: `
        <h2>LinkedIn Session Expired</h2>
        <p>Your LinkedIn cookies have expired. The system can no longer scrape LinkedIn job listings.</p>
        <p><strong>To fix this:</strong></p>
        <ol>
          <li>Open terminal in the career-ops folder</li>
          <li>Run: <code>node linkedin-auto-save.js</code></li>
          <li>Log in to LinkedIn in the browser window</li>
          <li>Wait for "Cookies saved" message</li>
        </ol>
        <p>This takes about 30 seconds. The system will automatically use the new cookies.</p>
        <hr>
        <p><small>— Career-Ops Automation</small></p>
      `,
    });
    
    console.log('📧 Expiration email sent');
  } catch (err) {
    // Silent fail on email
  }
}

// ─── Headless scraping with Puppeteer Stealth ──────────────────────────────

async function scrapeLinkedInJobs(keywords, maxJobs = 25, userId) {
  const data = await loadCookies(userId);
  
  if (!data || data.cookies.length === 0) {
    console.log('  ⚠️  LinkedIn: No cookies. Run: node linkedin-auto-save.js');
    return [];
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  
  if (!valid) {
    console.log(`  ❌ LinkedIn: Cookies expired (${days}d). Re-login needed.`);
    await sendExpirationEmail();
    return [];
  }
  
  if (days > 25) {
    console.log(`  ⚠️  LinkedIn: Cookies expiring in ${30 - days} days.`);
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Inject saved cookies
    await page.setCookie(...data.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true,
    })));
    
    // Build search URL
    const params = new URLSearchParams({
      keywords,
      f_WT: '2',         // Remote
      f_TPR: 'r604800',  // Last 7 days
      sortBy: 'DD',      // Date Descending
    });
    
    const url = `https://www.linkedin.com/jobs/search/?${params}`;
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for SPA to render job cards
    await page.waitForFunction(() => {
      return document.querySelectorAll('a[href*="/jobs/view/"]').length > 0 ||
             document.querySelector('.jobs-search-no-results') !== null;
    }, { timeout: 30000 }).catch(() => {});
    
    // Check if redirected to login
    if (page.url().includes('/login') || page.url().includes('checkpoint') || page.url().includes('authwall')) {
      console.log('  ❌ LinkedIn: Session expired during scraping.');
      await sendExpirationEmail();
      return [];
    }
    
    // Scrape jobs
    const jobs = await page.evaluate((maxJobs) => {
      const links = document.querySelectorAll('a[href*="/jobs/view/"]');
      const seen = new Set();
      
      return Array.from(links)
        .map(a => {
          // Clean up title (LinkedIn duplicates text)
          let title = a.textContent.trim();
          const half = Math.floor(title.length / 2);
          if (title.length > 4 && title.substring(0, half) === title.substring(half)) {
            title = title.substring(0, half);
          }
          
          return {
            title: title,
            url: a.href.split('?')[0],
          };
        })
        .filter(j => {
          if (!j.title || seen.has(j.url)) return false;
          seen.add(j.url);
          return true;
        })
        .slice(0, maxJobs);
    }, maxJobs);
    
    return jobs;
    
  } catch (err) {
    if (err.message.includes('timeout')) {
      console.log('  ⚠️  LinkedIn: Scraping timeout.');
    } else {
      console.error('  ❌ LinkedIn:', err.message);
    }
    return [];
  } finally {
    await browser.close();
  }
}

// ─── Auto-apply to LinkedIn Easy Apply jobs ──────────────────────────────────

async function applyToJob(url, userId, candidateInfo, cvPath) {
  const data = await loadCookies(userId);
  if (!data || data.cookies.length === 0) {
    return { success: false, error: 'No LinkedIn cookies available' };
  }

  const { valid } = checkCookieAge(data.exportedAt);
  if (!valid) {
    return { success: false, error: 'LinkedIn cookies expired' };
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setCookie(...data.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true,
    })));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (page.url().includes('/login') || page.url().includes('authwall')) {
      return { success: false, error: 'LinkedIn session expired — re-login needed' };
    }

    await page.waitForSelector('.jobs-apply-button, button[aria-label*="Apply"]', { timeout: 15000 }).catch(() => {});

    const applyBtn = await page.$('.jobs-apply-button, button[aria-label*="Apply"]');
    if (!applyBtn) {
      return { success: false, error: 'No Apply button found — may require external redirect' };
    }

    await applyBtn.click();
    await page.waitForSelector('.jobs-easy-apply-modal, .artdeco-modal', { timeout: 10000 }).catch(() => {});

    const confirmationPatterns = [/thank you/i, /submitted/i, /application complete/i, /applied/i];
    const nextStepSelectors = [
      'button[aria-label="Continue to next step"]',
      'button[aria-label="Review your application"]',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Review")',
    ];
    const submitSelectors = [
      'button[aria-label="Submit application"]',
      'button:has-text("Submit application")',
      'button:has-text("Submit")',
    ];

    for (let step = 0; step < 8; step++) {
      // 1. Run browser evaluation to fill all types of questions and standard fields
      await page.evaluate((candidate) => {
        const Q_ANSWERS = {
          'one sentence': 'I founded and built 4 automated SaaS businesses including Career Flow (job search pipeline), Unimark (small business AI marketing), APEX Website Solutions (B2B lead gen engine), and Lumi & Milo (autonomous YouTube content pipeline).',
          'automation you built': 'I built Career Flow (job search pipeline automation), Unimark (AI marketing SaaS), APEX Website Solutions (B2B lead gen engine), and Lumi & Milo (autonomous video production pipeline).',
          'internal tool': 'I built a multi-agent content production pipeline with a QC agent that reviews all output for tone, pacing, and brand consistency before human approval, reducing production effort to a single click.',
          'tool you built': 'I built a multi-agent content production pipeline with a QC agent that reviews all output for tone, pacing, and brand consistency before human approval, reducing production effort to a single click.',
          'why.*company': 'I have spent 6+ years building AI-powered automation systems for marketing and sales operations. Your company is at the intersection of AI and intelligent workflows, which is exactly where I want to apply my experience building production agents.',
          'why.*role': 'This role combines my core strengths: building AI-powered automation systems, managing marketing operations, and translating business needs into technical solutions across the 4 businesses I founded.',
          'why.*interest': 'I am passionate about building AI systems that replace manual operations with intelligent automation. Your mission aligns perfectly with my experience and career direction.',
          'years of experience': '6+ years building AI-powered automation systems across lead generation, content production, and marketing operations.',
          'salary expectation': '70000',
          'desired salary': '70000',
          'expected salary': '70000',
          'salary': '70000',
          'compensation': '70000',
          'money': '70000',
          'pay': '70000',
          'start date': 'Available immediately',
          'available': 'Available immediately',
          'notice period': 'Available immediately',
          'sponsorship': 'No',
          'visa sponsorship': 'No',
          'require sponsorship': 'No',
          'require.*sponsorship': 'No',
          'visa': 'No',
          'authorized to work': 'Yes',
          'work authorization': 'Yes',
          'currently located': 'Gold Coast, QLD, Australia',
          'where are you': 'Gold Coast, QLD, Australia',
          'relocate': 'No',
          'remote': 'Yes',
          'managed a team': 'I have built and operated AI automation systems across 4 businesses I founded, acting as IC, architect, and operator.',
          'management experience': 'I have built and operated AI automation systems across 4 businesses I founded, acting as IC, architect, and operator.',
          'technical skills': 'TypeScript, Node.js, Python, REST APIs, Webhooks, n8n, Claude API, Gemini API, Vapi, Bland AI, Telnyx AI, Facebook Graph API, Google Analytics.',
          'programming': 'TypeScript, Node.js, Python, HTML, CSS, REST APIs, Webhooks.',
          'ai experience': 'I have 6+ years of hands-on AI experience: building multi-agent orchestration systems, deploying AI voice agents (Vapi, Bland AI, Telnyx), integrating Claude and Gemini APIs, and automating workflows with n8n.',
          'cover letter': 'Please see my attached cover letter and CV. I am excited about this opportunity and would welcome the chance to discuss how my experience can contribute.',
          'additional information': 'I bring a unique combination of technical depth (TypeScript, Node.js, Python) and business outcomes (founded 4 automated businesses). I do not just evaluate AI tools; I build production systems with them.',
          'how did you hear': 'I found this position through job board scanning and was immediately drawn to the role\'s focus on AI-powered automation.',
        };

        function answerQuestion(questionText, options = []) {
          const q = (questionText || '').toLowerCase();

          if (q.includes('sponsorship') || q.includes('visa') || q.includes('sponsoring')) {
            if (options.length > 0) {
              const match = options.find(o => (o.text || '').toLowerCase().includes('no'));
              if (match) return match.value || match.text;
            }
            return 'No';
          }

          if (q.includes('authorized') || q.includes('work in') || (q.includes('work') && q.includes('australia'))) {
            if (options.length > 0) {
              const match = options.find(o => (o.text || '').toLowerCase().includes('yes'));
              if (match) return match.value || match.text;
            }
            return 'Yes';
          }

          if (q.includes('salary') || q.includes('compensation') || q.includes('money') || q.includes('pay') || q.includes('remuneration') || q.includes('rate')) {
            if (options.length > 0) {
              const match = options.find(o => (o.text || '').includes('70') || (o.text || '').toLowerCase().includes('market') || (o.text || '').includes('60') || (o.text || '').includes('80'));
              if (match) return match.value || match.text;
            }
            return '70000';
          }

          if (q.includes('relocate') || q.includes('commute')) {
            if (options.length > 0) {
              const match = options.find(o => (o.text || '').toLowerCase().includes('no'));
              if (match) return match.value || match.text;
            }
            return 'No';
          }

          for (const [pattern, answer] of Object.entries(Q_ANSWERS)) {
            try {
              const reg = new RegExp(pattern.toLowerCase(), 'i');
              if (reg.test(q) || q.includes(pattern.toLowerCase())) {
                if (options.length > 0) {
                  const match = options.find(o => (o.text || '').toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes((o.text || '').toLowerCase()));
                  if (match) return match.value || match.text;
                }
                return answer;
              }
            } catch (e) {}
          }

          if (options.length > 0) {
            const positive = options.find(o => {
              const t = (o.text || '').toLowerCase();
              return t.includes('yes') || t.includes('australia') || t.includes('full') || t.includes('immediately') || t.includes('remote');
            });
            if (positive) return positive.value || positive.text;

            const validOpt = options.find(o => o.value && o.value !== '' && o.value !== '0' && (o.text || '').trim() !== '');
            if (validOpt) return validOpt.value || validOpt.text;
          }

          return 'Yes';
        }

        // Fill inputs, textareas
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea'));
        inputs.forEach(input => {
          let labelText = '';
          let parent = input.parentElement;
          for (let i = 0; i < 4 && parent; i++) {
            const label = parent.querySelector('label');
            if (label) {
              labelText = label.innerText || '';
              break;
            }
            parent = parent.parentElement;
          }

          const q = labelText.toLowerCase();
          if (q.includes('first name') || q.includes('given name')) {
            input.value = candidate.firstName || '';
          } else if (q.includes('last name') || q.includes('family name')) {
            input.value = candidate.lastName || '';
          } else if (q.includes('email')) {
            input.value = candidate.email || '';
          } else if (q.includes('phone') || q.includes('mobile')) {
            input.value = candidate.phone || '';
          } else if (q.includes('linkedin')) {
            input.value = candidate.linkedin || 'https://www.linkedin.com';
          } else if (q.includes('website') || q.includes('portfolio') || q.includes('github') || q.includes('twitter')) {
            input.value = candidate.website || 'https://www.ilseplacencia.shop';
          } else {
            input.value = answerQuestion(labelText);
          }
          
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Fill dropdowns
        const selects = Array.from(document.querySelectorAll('select'));
        selects.forEach(select => {
          let labelText = '';
          let parent = select.parentElement;
          for (let i = 0; i < 4 && parent; i++) {
            const label = parent.querySelector('label');
            if (label) {
              labelText = label.innerText || '';
              break;
            }
            parent = parent.parentElement;
          }

          const options = Array.from(select.options).map(o => ({ text: o.text || '', value: o.value || '' }));
          const bestVal = answerQuestion(labelText, options);
          if (bestVal) {
            select.value = bestVal;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });

        // Fill radio groups
        const radioGroups = Array.from(document.querySelectorAll('fieldset, div[role="radiogroup"]'));
        radioGroups.forEach(group => {
          const legend = group.querySelector('legend, [class*="legend"], [class*="label"]');
          if (!legend) return;
          const questionText = legend.innerText || '';
          
          const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
          if (radios.length === 0) return;
          
          const options = radios.map(r => {
            let text = '';
            const id = r.id;
            if (id) {
              const label = group.querySelector(`label[for="${id}"]`);
              if (label) text = label.innerText || '';
            }
            if (!text) {
              const parent = r.parentElement;
              if (parent) text = parent.innerText || '';
            }
            return { element: r, text, value: r.value || '' };
          });

          const bestValText = answerQuestion(questionText, options.map(o => ({ text: o.text, value: o.value })));
          if (bestValText) {
            const match = options.find(o => o.text.toLowerCase().includes(bestValText.toLowerCase()) || bestValText.toLowerCase().includes(o.text.toLowerCase()));
            if (match) {
              match.element.click();
              match.element.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              options[0].element.click();
              options[0].element.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });

        // Checkboxes
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        checkboxes.forEach(cb => {
          let text = '';
          const id = cb.id;
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) text = label.innerText || '';
          }
          if (!text && cb.parentElement) {
            text = cb.parentElement.innerText || '';
          }
          const t = text.toLowerCase();
          if (t.includes('agree') || t.includes('consent') || t.includes('terms') || t.includes('privacy') || cb.required) {
            if (!cb.checked) {
              cb.click();
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
      }, candidateInfo);

      // 2. Resume upload handling (Playwright side)
      if (cvPath && existsSync(cvPath)) {
        const fileInputs = await page.$$('input[type="file"]');
        for (const fi of fileInputs) {
          const accept = await fi.getAttribute('accept') || '';
          const visible = await fi.evaluate(el => el.offsetParent !== null).catch(() => false);
          if (visible && (accept.includes('pdf') || accept.includes('document') || accept.includes('image'))) {
            try {
              await fi.uploadFile(cvPath);
              await new Promise(r => setTimeout(r, 2000));
            } catch {}
            break;
          }
        }
      }

      // 3. Check for application success
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (confirmationPatterns.some(p => p.test(pageText))) {
        return { success: true, method: 'LinkedIn Easy Apply (step ' + step + ')' };
      }

      // 4. Try submitting or advancing
      let clicked = false;
      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible().catch(() => false)) {
            await btn.click();
            clicked = true;
            break;
          }
        } catch {}
      }

      if (clicked) {
        await new Promise(r => setTimeout(r, 3000));
        const afterText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (confirmationPatterns.some(p => p.test(afterText))) {
          return { success: true, method: 'LinkedIn Easy Apply' };
        }
        continue;
      }

      for (const sel of nextStepSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible().catch(() => false)) {
            await btn.click();
            clicked = true;
            break;
          }
        } catch {}
      }

      if (clicked) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      break;
    }

    return { success: false, error: 'Could not complete LinkedIn application form — may need manual review' };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ─── Provider interface (default export for registry) ─────────────────────

export default {
  id: 'linkedin',
  name: 'LinkedIn Jobs',
  
  detect(ctx) {
    return false;
  },

  async fetch(entry, ctx) {
    const { readFileSync, existsSync } = await import('fs');
    const yaml = await import('js-yaml');
    let defaultQuery = '"AI Trainer" OR "Video Editor" OR "Webflow" OR "Virtual Assistant" OR "QA"';
    try {
      if (existsSync('portals.yml')) {
        const config = yaml.load(readFileSync('portals.yml', 'utf8'));
        const positive = config?.title_filter?.positive || [];
        const mainKeywords = positive.filter(k => k.length >= 2 && k.length <= 25);
        if (mainKeywords.length > 0) {
          const selected = [...new Set(mainKeywords)].slice(0, 8);
          defaultQuery = selected.map(k => `"${k}"`).join(' OR ');
        }
      }
    } catch (e) {
      // Fallback to default
    }
    const keywords = entry.scan_query || entry.searchKeywords || defaultQuery;
    return scrapeLinkedInJobs(keywords, 25, ctx?.userId);
  },

  async apply(url, ctx) {
    return applyToJob(url, ctx?.userId, ctx?.candidateInfo || {}, ctx?.cvPath);
  },
};

// ─── Standalone testing ────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('linkedin.mjs')) {
  console.log('\n🔍 Testing LinkedIn provider (headless)...\n');
  
  const data = loadCookies();
  if (!data) {
    console.log('❌ No config found. Run: node linkedin-auto-save.js');
    process.exit(1);
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  console.log(`Cookie age: ${days} days, Valid: ${valid}`);
  
  if (!valid) {
    console.log('❌ Cookies expired. Run: node linkedin-auto-save.js');
    process.exit(1);
  }
  
  scrapeLinkedInJobs('AI automation', 10).then(jobs => {
    console.log(`\n✅ Found ${jobs.length} jobs:\n`);
    jobs.forEach((job, i) => {
      console.log(`${i + 1}. ${job.title}`);
      console.log(`   ${job.url}\n`);
    });
  }).catch(err => {
    console.error('❌ Error:', err.message);
  });
}
