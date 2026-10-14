import { hashPassphrase, MIN_PASSPHRASE_LENGTH } from './passphrase.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function stripOneLineEnding(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

async function main(): Promise<void> {
  const passphrase = stripOneLineEnding(await readStdin());
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    process.stderr.write('Passphrase must be at least 12 characters\n');
    process.exit(1);
  }
  process.stdout.write(`${hashPassphrase(passphrase)}\n`);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`Could not hash passphrase: ${reason}\n`);
  process.exit(1);
});
