import { OpenAI } from 'openai';
import dotenv from 'dotenv';
dotenv.config();

// Simple prompt to rewrite the CV content
function buildTailoringPrompt(cvText, jdText) {
  return `You are an expert ATS optimization AI. Your job is to rewrite a candidate's CV content to PERFECTLY match the provided Job Description.

Target Job Description:
${jdText}

Candidate's Base CV Data:
${cvText}

RULES:
1. Rewrite the "Summary" to highlight exactly why the candidate is a perfect fit for this JD.
2. Rewrite the "Experience" bullet points to highlight skills and achievements most relevant to the JD. You MUST use keywords from the JD naturally.
3. You may slightly adapt the "Role" title to better match the JD (e.g., "Software Engineer" -> "Senior Software Engineer" if the JD requires it, but DO NOT hallucinate a completely fake role).
4. DO NOT CHANGE: Company names, employment dates, locations, or educational degrees.
5. Extract and format the technical skills exactly as needed for the JD.

OUTPUT FORMAT:
Return a raw JSON object (without markdown code blocks) matching this exact structure:
{
  "summary": "Tailored professional summary string...",
  "experience": [
    {
      "company": "Original Company Name",
      "role": "Tailored Role Name",
      "dates": "Original Dates",
      "location": "Original Location",
      "bullets": ["Tailored bullet 1...", "Tailored bullet 2..."]
    }
  ],
  "skills": [
    {
      "category": "Optional Category Name (e.g. Languages)",
      "items": "Tailored list of skills..."
    }
  ]
}
`;
}

export async function generateLLMTailoredCV(profile, cvText, jdText) {
  const providers = profile.llm_providers || [];
  if (providers.length === 0) {
    throw new Error("No LLM providers configured in profile.yml under 'llm_providers'");
  }

  const prompt = buildTailoringPrompt(cvText, jdText);

  // Waterfall logic
  for (const provider of providers) {
    try {
      const apiKey = process.env[provider.apiKeyEnv];
      if (!apiKey) {
        console.log(`[LLM Waterfall] Skipping ${provider.name} - Missing ${provider.apiKeyEnv}`);
        continue;
      }

      console.log(`[LLM Waterfall] Attempting to use ${provider.name} (${provider.model})...`);
      
      const openai = new OpenAI({
        apiKey: apiKey,
        baseURL: provider.baseURL,
      });

      // Some providers don't fully support response_format: { type: "json_object" } perfectly via the wrapper, 
      // but most modern ones do. We'll include it and also parse gracefully.
      const requestPayload = {
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
      };
      
      // OpenAI and Groq and Together support json_object, but we'll try without it to be safe for Gemini via some wrappers, 
      // or we can just parse the string for JSON.
      // We will parse the string for JSON since we said "without markdown code blocks".

      const response = await openai.chat.completions.create(requestPayload);
      let content = response.choices[0].message.content;
      
      // Graceful JSON parsing in case LLM added markdown ```json
      content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(content);
      
      console.log(`[LLM Waterfall] Successfully generated CV using ${provider.name}!`);
      return parsed;
      
    } catch (error) {
      console.error(`[LLM Waterfall] ${provider.name} failed:`, error.message);
      // Continue to the next provider in the loop
    }
  }

  throw new Error("All LLM providers in the waterfall failed to generate the CV.");
}

function buildReferenceLetterPrompt(jdText, profile) {
  return `You are an expert ATS optimization AI. Your job is to write a reference letter for a candidate that highlights their skills and traits that perfectly match the provided Job Description.

Target Job Description:
${jdText}

Candidate Profile:
${JSON.stringify(profile)}

RULES:
1. Write the letter from the perspective of "Taylor Chorley", Digital Marketing Supervisor at Evolve Marketing.
2. The letter must be in HTML format, structured exactly like the provided template.
3. Keep the header, brand, meta tags, and signature block exactly the same as the template.
4. ONLY modify the <div class="content">...</div> section to highlight the candidate's achievements and traits that are most relevant to the target job description.
5. Use a warm, professional, and authentic tone. Make it sound like a real person wrote it, not an AI.

TEMPLATE TO FOLLOW AND FILL IN:
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Reference Letter for Ilse Placencia</title><style>body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1a1a2e;line-height:1.6;max-width:680px;margin:40px auto;padding:0 30px;background:#ffffff;}.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #107b89;padding-bottom:20px;margin-bottom:30px;}.brand{font-size:28px;font-weight:800;letter-spacing:-1px;color:#107b89;}.brand span{color:#8b5cf6;}.brand-sub{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#64748b;font-weight:600;}.title{font-size:20px;font-weight:700;color:#0f172a;margin-bottom:15px;}.meta{font-size:13px;color:#475569;background:#f8fafc;padding:12px 16px;border-radius:8px;margin-bottom:25px;border-left:4px solid #107b89;}.meta p{margin:3px 0;}.content p{font-size:14px;color:#334155;margin-bottom:16px;}.signature-block{margin-top:35px;padding-top:20px;border-top:1px solid #e2e8f0;}.sign-name{font-family:'Brush Script MT','cursive',sans-serif;font-size:24px;color:#0f172a;margin-bottom:5px;}.sign-title{font-size:13px;font-weight:600;color:#0f172a;}.sign-contact{font-size:12px;color:#64748b;}</style></head><body><div class="header"><div><div class="brand">ev<span>o</span>lve</div><div class="brand-sub">MARKETING</div></div></div><div class="title">Reference Letter for Ilse Placencia</div><div class="meta"><p><strong>From:</strong> Taylor Chorley</p><p><strong>Position:</strong> Digital Marketing Supervisor, Evolve Marketing</p><p><strong>Date:</strong> October 26th, 2025</p></div><div class="content">
[YOUR REWRITTEN CONTENT GOES HERE. PARAGRAPHS WRAPPED IN <p> TAGS]
</div><div class="signature-block"><div class="sign-name">Taylor Chorley</div><div class="sign-title">Taylor Chorley</div><div class="sign-contact">Digital Marketing Supervisor, Evolve Marketing</div><div class="sign-contact">taylorchorley@gmail.com | +1 (604) 551-8229</div></div></body></html>

OUTPUT FORMAT:
Return ONLY the raw HTML string. Do not include markdown code blocks.`;
}

export async function generateLLMReferenceLetter(profile, jdText) {
  const providers = profile.llm_providers || [];
  if (providers.length === 0) {
    throw new Error("No LLM providers configured in profile.yml under 'llm_providers'");
  }

  const prompt = buildReferenceLetterPrompt(jdText, profile);

  // Waterfall logic
  for (const provider of providers) {
    try {
      const apiKey = process.env[provider.apiKeyEnv];
      if (!apiKey) {
        continue;
      }

      console.log(`[LLM Waterfall] Attempting to use ${provider.name} (${provider.model}) for Reference Letter...`);
      
      const openai = new OpenAI({
        apiKey: apiKey,
        baseURL: provider.baseURL,
      });

      const requestPayload = {
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
      };

      const response = await openai.chat.completions.create(requestPayload);
      let content = response.choices[0].message.content;
      
      // Graceful parsing in case LLM added markdown ```html
      content = content.replace(/```html/gi, '').replace(/```/g, '').trim();
      
      console.log(`[LLM Waterfall] Successfully generated Reference Letter using ${provider.name}!`);
      return content;
      
    } catch (error) {
      console.error(`[LLM Waterfall] ${provider.name} failed for Reference Letter:`, error.message);
    }
  }

  throw new Error("All LLM providers in the waterfall failed to generate the Reference Letter.");
}
