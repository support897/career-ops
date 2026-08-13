import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_KEY = process.env.ENCRYPTION_KEY || 'e6372655010edff3b49a51385cc08e23f3e4126616e11f0963a7711c5a402503';

function getKey(): Buffer {
  return crypto.scryptSync(DEFAULT_KEY, 'career-ops-salt', 32);
}

/**
 * Encrypt plaintext string using AES-256-GCM
 */
export function encryptData(text: string): { iv: string; content: string; tag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    iv: iv.toString('hex'),
    content: encrypted,
    tag,
  };
}

/**
 * Decrypt AES-256-GCM encrypted payload
 */
export function decryptData(encrypted: { iv: string; content: string; tag: string }): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(encrypted.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
  let decrypted = decipher.update(encrypted.content, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export const PRINCIPAL_PROFILE = {
  candidate: {
    fullName: "Ilse Placencia",
    email: "placenciailse@gmail.com",
    phone: "04 98570497",
    location: "Gold Coast, QLD, Australia",
    portfolioUrl: "https://www.ilseplacencia.shop",
  },
  targetRoles: [
    "AI Data Trainer / Evaluator",
    "Video Editor & Content Specialist",
    "Junior Webflow / Framer Designer",
    "Bilingual Technical Virtual Assistant",
  ],
  positiveIncludes: [
    "AI Automation",
    "AI Testing",
    "AI Evaluator",
    "Data Annotation",
    "QA",
    "Testing",
    "Quality Assurance",
    "Video Editor",
    "Web Designer",
    "Spanish",
    "Social Media Coordinator",
    "digital marketing",
    "website builder",
  ],
  negativeExcludes: [
    "engineer",
    "architect",
    "senior researcher",
    "staff engineer",
    "devops",
    "platform engineer",
    "support worker",
    "ndis coordinator",
  ],
  locationPolicy: {
    allowed: ["Remote", "Work from home", "WFH", "Australia", "Worldwide"],
    blocked: ["On-site", "Onsite", "United States", "USA", "US Only", "US Remote", "Remote - US"],
  },
};
