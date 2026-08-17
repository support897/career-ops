/**
 * reference-letter-generator.mjs — Keyword-based reference letter generation.
 *
 * Generates a tailored reference letter natively without using the LLM.
 */

import { extractJDKeywords } from './cover-letter-generator.mjs';

// The same experience map to keep proof points consistent across documents
const EXPERIENCE_MAP = {
  automation: {
    superpower: 'End-to-end automation pipeline design',
    proof: 'At Fiesta Fresh Cleaning, she built a fully automated B2B lead generation engine that scrapes prospects, generates audit reports, sends cold emails, and books calls 24/7 with zero manual input.',
    company: 'Fiesta Fresh Cleaning',
  },
  ai: {
    superpower: 'Multi-agent orchestration and AI voice agents',
    proof: 'She designed a multi-agent YouTube content pipeline at Lumi and Milo with a dedicated QC agent using Python, Gemini API, and Google Antigravity orchestration.',
    company: 'Lumi and Milo',
  },
  marketing: {
    superpower: 'Marketing automation across Facebook, email, SEO, and web',
    proof: 'I personally oversaw her work planning and executing full-funnel digital campaigns at Evolve Marketing across multiple product launches in our remote, async-first team.',
    company: 'Evolve Marketing',
  },
  lead_generation: {
    superpower: 'B2B lead generation and cold outreach automation',
    proof: 'She built a complete lead generation system at APEX that scrapes qualified prospects, generates personalized audits, sends cold emails, and books discovery calls through an AI voice agent.',
    company: 'Fiesta Fresh Cleaning',
  },
  n8n: {
    superpower: 'Workflow orchestration with n8n, Make, and Node.js',
    proof: 'She architected automated workflows at APEX using n8n and Google Antigravity that handle prospect scraping, audit generation, email sequences, and call booking.',
    company: 'Fiesta Fresh Cleaning',
  },
  python: {
    superpower: 'Python development for AI applications',
    proof: 'She developed highly complex AI pipelines using Python at Lumi and Milo, orchestrating agents that significantly increased our video output quality and volume.',
    company: 'Lumi and Milo',
  },
};

function matchToExperience(jdKeywords) {
  const matches = [];
  const seen = new Set();
  for (const kw of jdKeywords) {
    const entry = EXPERIENCE_MAP[kw];
    if (entry && !seen.has(entry.company + entry.superpower)) {
      matches.push({ keyword: kw, ...entry });
      seen.add(entry.company + entry.superpower);
    }
  }
  return matches;
}

export function generateReferenceLetter(profile, job, jdText) {
  const jdKeywords = extractJDKeywords(jdText);
  const matches = matchToExperience(jdKeywords);
  
  const company = job?.company || 'your company';
  const role = job?.title || job?.role || 'the open position';
  const fullName = profile?.fullName || profile?.full_name || 'Ilse Placencia';

  // Build the content dynamically based on keyword matches
  let contentHtml = `<p>To the Hiring Team at ${company},</p>`;
  contentHtml += `<p>It is my absolute pleasure to write this letter of recommendation for ${fullName} as she applies for the ${role} position. During her time working with us, she consistently demonstrated an exceptional ability to solve complex problems through technical ingenuity and automation.</p>`;

  if (matches.length > 0) {
    const topMatches = matches.slice(0, 3);
    contentHtml += `<p>I noticed your role requires expertise in ${topMatches.map(m => m.keyword.replace(/_/g, ' ')).join(', ')}. This aligns perfectly with her strengths. For example:</p>`;
    contentHtml += `<ul>`;
    for (const match of topMatches) {
      contentHtml += `<li><strong>${match.superpower}</strong>: ${match.proof}</li>`;
    }
    contentHtml += `</ul>`;
  } else {
    contentHtml += `<p>She builds AI-powered automation systems that replace manual operations with intelligent workflows. At Evolve Marketing, she planned and executed full-funnel digital campaigns across multiple product launches in a fully remote, async-first team.</p>`;
  }

  contentHtml += `<p>Beyond her technical skills, she is a highly driven and resourceful professional who thrives in fast-paced environments. I am confident that she will be a tremendous asset to ${company}.</p>`;
  contentHtml += `<p>Please feel free to contact me if you need any further information.</p>`;

  // Render the final HTML string
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Reference Letter for ${fullName}</title><style>body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1a1a2e;line-height:1.6;max-width:680px;margin:40px auto;padding:0 30px;background:#ffffff;}.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #107b89;padding-bottom:20px;margin-bottom:30px;}.brand{font-size:28px;font-weight:800;letter-spacing:-1px;color:#107b89;}.brand span{color:#8b5cf6;}.brand-sub{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#64748b;font-weight:600;}.title{font-size:20px;font-weight:700;color:#0f172a;margin-bottom:15px;}.meta{font-size:13px;color:#475569;background:#f8fafc;padding:12px 16px;border-radius:8px;margin-bottom:25px;border-left:4px solid #107b89;}.meta p{margin:3px 0;}.content p{font-size:14px;color:#334155;margin-bottom:16px;}.content ul{font-size:14px;color:#334155;margin-bottom:16px;}.content li{margin-bottom:8px;}.signature-block{margin-top:35px;padding-top:20px;border-top:1px solid #e2e8f0;}.sign-name{font-family:'Brush Script MT','cursive',sans-serif;font-size:24px;color:#0f172a;margin-bottom:5px;}.sign-title{font-size:13px;font-weight:600;color:#0f172a;}.sign-contact{font-size:12px;color:#64748b;}</style></head><body><div class="header"><div><div class="brand">ev<span>o</span>lve</div><div class="brand-sub">MARKETING</div></div></div><div class="title">Reference Letter for ${fullName}</div><div class="meta"><p><strong>From:</strong> Taylor Chorley</p><p><strong>Position:</strong> Digital Marketing Supervisor, Evolve Marketing</p><p><strong>Date:</strong> ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p></div><div class="content">${contentHtml}</div><div class="signature-block"><div class="sign-name">Taylor Chorley</div><div class="sign-title">Taylor Chorley</div><div class="sign-contact">Digital Marketing Supervisor, Evolve Marketing</div><div class="sign-contact">taylorchorley@gmail.com | +1 (604) 551-8229</div></div></body></html>`;
}
