const fs = require('fs');
const yaml = require('yaml');

const profileRaw = fs.readFileSync('config/profile.yml', 'utf-8');
const profile = yaml.parse(profileRaw);

// Add generation mode
profile.cv_generation_mode = 'llm'; // or 'keyword'

// Add waterfall providers
profile.llm_providers = [
  {
    name: "Groq",
    model: "llama3-70b-8192",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY" // Needs to be added to .env
  },
  {
    name: "OpenRouter",
    model: "google/gemini-flash-1.5",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY"
  },
  {
    name: "Gemini",
    model: "gemini-1.5-flash",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", // Gemini's OpenAI compatible endpoint
    apiKeyEnv: "GEMINI_API_KEY"
  },
  {
    name: "TogetherAI",
    model: "meta-llama/Llama-3-70b-chat-hf",
    baseURL: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY"
  },
  {
    name: "Cohere",
    model: "command-r",
    baseURL: "https://api.cohere.ai/v1", // Note: Cohere doesn't have a 1:1 OpenAI wrapper built-in directly but there are proxies. We might skip cohere if we want strict OpenAI compat, or use OpenAI's lib via openrouter.
    apiKeyEnv: "COHERE_API_KEY"
  },
  {
    name: "OpenAI Fallback",
    model: "gpt-4o-mini",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY"
  }
];

fs.writeFileSync('config/profile.yml', yaml.stringify(profile));
console.log('Profile updated.');
