import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Connects to Gmail via IMAP, looks for the most recent unread email
 * containing an OTP/verification code from the last 5 minutes.
 */
export async function getRecentOTP(domain = '') {
  console.log('   📧 Connecting to Gmail to fetch OTP...');
  
  let configStr;
  try {
    configStr = readFileSync(join(__dirname, '../config/email.yml'), 'utf8');
  } catch (e) {
    console.error('   ❌ Could not read config/email.yml for IMAP credentials.');
    return null;
  }
  
  const config = yaml.load(configStr);
  if (!config?.gmail?.user || !config?.gmail?.app_password) {
    console.error('   ❌ Missing gmail credentials in config/email.yml');
    return null;
  }

  const imapConfig = {
    imap: {
      user: config.gmail.user,
      password: config.gmail.app_password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 10000
    }
  };

  try {
    const connection = await imaps.connect(imapConfig);
    await connection.openBox('INBOX');

    // Search for unread emails from the last hour
    const delay = 1 * 3600 * 1000;
    const since = new Date(Date.now() - delay);
    
    const searchCriteria = ['UNSEEN', ['SINCE', since]];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: true
    };

    const results = await connection.search(searchCriteria, fetchOptions);
    if (!results || results.length === 0) {
      console.log('   ⚠️  No recent unread emails found.');
      connection.end();
      return null;
    }

    // Sort by most recent first
    results.sort((a, b) => new Date(b.attributes.date).getTime() - new Date(a.attributes.date).getTime());

    for (const res of results) {
      const allParts = imaps.getParts(res.attributes.struct);
      const textPart = allParts.find(p => p.subtype === 'plain' || p.subtype === 'html');
      
      const headerPart = res.parts.find(p => p.which === 'HEADER');
      const bodyPart = res.parts.find(p => p.which === 'TEXT');
      
      const parsed = await simpleParser(headerPart.body + '\r\n\r\n' + bodyPart.body);
      
      const subject = parsed.subject || '';
      const text = parsed.text || parsed.html || '';
      const from = parsed.from?.text || '';

      // If we provided a domain to look for (like 'workday.com' or 'smartrecruiters.com')
      if (domain && !from.toLowerCase().includes(domain.toLowerCase()) && !subject.toLowerCase().includes(domain.toLowerCase())) {
        continue;
      }

      // Try to extract a 6-digit or 4-digit code
      // Common formats: "Your verification code is 123456" or "123456"
      const codeMatch = text.match(/\b(\d{4,8})\b/);
      if (codeMatch && codeMatch[1]) {
        console.log(`   ✅ Found OTP from ${from}: ${codeMatch[1]}`);
        connection.end();
        return codeMatch[1];
      }
    }
    
    console.log('   ⚠️  No OTP found in recent emails.');
    connection.end();
    return null;
  } catch (error) {
    console.error('   ❌ IMAP Error:', error.message);
    return null;
  }
}
