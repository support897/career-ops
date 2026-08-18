/**
 * approved-email.mjs — the single approved Gmail draft shape.
 *
 * There used to be two: the dashboard route (web/src/app/api/gmail/draft)
 * and auto-apply.mjs's own generatePersonalizedEmail(). The hourly worker
 * creates most drafts, so most drafts were the wrong one. This module holds
 * the approved wording so the worker produces exactly what the dashboard does:
 * a fixed opening line, the job's tailored achievement bullets, a fixed close.
 * Only the bullets change per job.
 */

function stripTags(fragment) {
  return String(fragment)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull tailored achievement bullets out of a cover letter (HTML or plain). */
export function extractBullets(coverLetter) {
  if (!coverLetter) return [];
  const text = String(coverLetter);
  const looksLikeHtml = /<\/?(p|div|li|ul|html|body|span|style)\b/i.test(text);
  if (looksLikeHtml) {
    const clean = text
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '');
    const items = [...clean.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    if (items.length) return items;
    const container = clean.match(
      /<(div|section)\b[^>]*class="[^"]*\bachievements\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i,
    );
    if (container) {
      const paras = [...container[2].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => stripTags(m[1]))
        .filter((t) => t.length > 30);
      if (paras.length) return paras;
    }
    return [];
  }
  const bullets = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^[*\-\u2022]\s+\S/.test(line)) continue;
    const cleaned = line.replace(/^[*\-\u2022]\s+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned) bullets.push(cleaned);
  }
  return bullets;
}

/**
 * Build the approved subject and body.
 * Returns null when no bullets can be found — a draft with no tailored content
 * is worse than no draft, and the next cycle will retry once documents exist.
 */
export function buildApprovedEmail({ role, company, fullName, applyUrl, coverLetterHtml, coverLetterText }) {
  let bullets = extractBullets(coverLetterHtml);
  if (!bullets.length) bullets = extractBullets(coverLetterText);
  if (!bullets.length) return null;
  const subject = `Application: ${role} - ${fullName}`;
  const lines = [
    `I believe I'm the perfect candidate for the ${role} role at ${company}.`,
    '',
    ...bullets.map((b) => `\u2022 ${b}`),
    '',
    'My CV, cover letter and a reference letter are attached as PDFs.',
    '',
    'Kind regards,',
    fullName,
  ];
  if (applyUrl) lines.push('', applyUrl);
  return { subject, body: lines.join('\n') };
}
