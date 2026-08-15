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
