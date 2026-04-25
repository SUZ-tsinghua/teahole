#!/usr/bin/env node

// Import an authorized roster export into the registration allowlist.
// The server hashes entries in memory; this file stays gitignored.
const fs = require('fs');
const path = require('path');

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(
    [
      'Usage: node scripts/import-allowlist.js [options] <roster-file...>',
      '',
      'Reads authorized CSV/TXT/HTML exports, extracts email addresses,',
      'deduplicates them, and writes one lowercase email per line.',
      '',
      'Options:',
      '  -o, --out <file>       Output allowlist file (default: DEPT_ALLOWLIST_FILE or ./dept-allowlist.txt)',
      '  --append               Merge with any existing output file instead of replacing it',
      '  --domain <domain>      Keep only emails at this domain; repeatable',
      '  --dry-run              Print the would-be result count without writing',
      '  -h, --help             Show this help',
      '',
      'Example:',
      '  node scripts/import-allowlist.js --domain mails.tsinghua.edu.cn roster.csv',
      '',
    ].join('\n')
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    files: [],
    domains: [],
    outFile: process.env.DEPT_ALLOWLIST_FILE || path.join(process.cwd(), 'dept-allowlist.txt'),
    append: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--append') {
      args.append = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '-o' || arg === '--out') {
      i += 1;
      if (!argv[i]) throw new Error(`${arg} needs a file path`);
      args.outFile = argv[i];
      continue;
    }
    if (arg === '--domain') {
      i += 1;
      if (!argv[i]) throw new Error('--domain needs a domain name');
      args.domains.push(normalizeDomain(argv[i]));
      continue;
    }
    if (arg.startsWith('--domain=')) {
      args.domains.push(normalizeDomain(arg.slice('--domain='.length)));
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    args.files.push(arg);
  }

  if (args.files.length === 0) usage(1);
  return args;
}

function normalizeDomain(domain) {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

function extractEmails(text) {
  const emails = new Set();
  for (const match of text.matchAll(EMAIL_RE)) {
    emails.add(match[0].toLowerCase());
  }
  return emails;
}

function readAllowlist(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const emails = new Set();
  const text = fs.readFileSync(filePath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (line) emails.add(line);
  }
  return emails;
}

function writeAllowlist(filePath, emails) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const body = `${Array.from(emails).sort().join('\n')}\n`;
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowedDomains = new Set(args.domains);
  const emails = args.append ? readAllowlist(args.outFile) : new Set();
  let seenInInputs = 0;

  for (const file of args.files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const email of extractEmails(text)) {
      seenInInputs += 1;
      const domain = email.split('@').pop();
      if (allowedDomains.size > 0 && !allowedDomains.has(domain)) continue;
      emails.add(email);
    }
  }

  if (args.dryRun) {
    console.log(`Found ${seenInInputs} input emails; allowlist would contain ${emails.size} entries.`);
    return;
  }

  writeAllowlist(args.outFile, emails);
  console.log(`Wrote ${emails.size} entries to ${args.outFile}.`);
}

try {
  main();
} catch (err) {
  console.error(`import-allowlist: ${err.message}`);
  process.exit(1);
}
