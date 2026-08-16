import imaps from 'imap-simple';
import jsyaml from 'js-yaml';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  try {
    const configData = jsyaml.load(readFileSync(join(__dirname, '../config/email.yml'), 'utf-8'));
    const user = configData?.gmail?.user;
    const pass = configData?.gmail?.app_password;

    if (!user || !pass) {
      console.error("Missing Gmail credentials in config/email.yml");
      return;
    }

    const config = {
      imap: {
        user,
        password: pass,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    };

    console.log("Connecting to IMAP...");
    const connection = await imaps.connect(config);
    
    console.log("Opening [Gmail]/Drafts...");
    await connection.openBox('[Gmail]/Drafts');

    // Search for all messages in the Drafts folder
    const searchCriteria = ['ALL'];
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };

    const messages = await connection.search(searchCriteria, fetchOptions);
    
    if (messages.length === 0) {
      console.log("No drafts found.");
    } else {
      console.log(`Found ${messages.length} drafts. Deleting...`);
      for (const msg of messages) {
        await connection.addFlags(msg.attributes.uid, '\\Deleted');
      }
      
      console.log("Expunging deleted drafts...");
      // Close the box which triggers expunge if set, but we can do it explicitly or use end() which might not expunge.
      // Better to explicitly expunge.
      await connection.imap.expunge();
      console.log("All drafts deleted successfully.");
    }
    
    connection.end();
  } catch (err) {
    console.error("Error deleting drafts:", err);
  }
}

run();
