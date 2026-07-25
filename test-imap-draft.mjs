#!/usr/bin/env node
import tls from 'tls';

const MSG = [
  'From: placenciailse@gmail.com',
  'To: test@example.com',
  'Subject: Test Draft from Careerflow',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'This is a test draft created via IMAP with your app password.',
  'Check your Gmail Drafts folder!',
].join('\r\n');

const socket = tls.connect({ host: 'imap.gmail.com', port: 993, rejectUnauthorized: false });
let buffer = '';
let tag = 0;
let waitingForLiteral = false;

function send(cmd) {
  tag++;
  const line = 'A' + tag + ' ' + cmd + '\r\n';
  process.stdout.write('>> ' + line.trim() + '\n');
  socket.write(line);
}

socket.on('data', (data) => {
  buffer += data.toString();
  const lines = buffer.split('\r\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    process.stdout.write('<< ' + line + '\n');
    
    if (line === '+ go ahead' && waitingForLiteral) {
      process.stdout.write('>> [sending message body]\n');
      socket.write(MSG + '\r\n');
      waitingForLiteral = false;
    }
    
    if (line.startsWith('A1 OK')) {
      send('SELECT "[Gmail]/Drafts"');
    } else if (line.startsWith('A2 OK')) {
      const byteLen = Buffer.byteLength(MSG);
      send(`APPEND "[Gmail]/Drafts" (\\Draft) {${byteLen}}`);
      waitingForLiteral = true;
    } else if (line.startsWith('A3 OK')) {
      process.stdout.write('\n✅ DRAFT CREATED! Check your Gmail Drafts folder.\n');
      send('LOGOUT');
      setTimeout(() => process.exit(0), 500);
    } else if (line.startsWith('A3 BAD') || line.startsWith('A3 NO')) {
      process.stdout.write('\n❌ APPEND failed: ' + line + '\n');
      send('LOGOUT');
      setTimeout(() => process.exit(1), 500);
    }
  }
});

socket.on('error', (err) => { console.error('Error:', err.message); process.exit(1); });

setTimeout(() => send('LOGIN placenciailse@gmail.com hptfiylhorjaakno'), 500);
