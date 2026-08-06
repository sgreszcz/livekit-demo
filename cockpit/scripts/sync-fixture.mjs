// Copies the canonical telemetry fixture out of docs/ so the SPA can bundle it.
// docs/fixtures/sample-call.jsonl is the shared agent<->cockpit contract sample;
// it lives outside this package's root, so Vite cannot import it directly.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../docs/fixtures/sample-call.jsonl');
const target = resolve(here, '../src/fixtures/sample-call.jsonl');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`fixture synced -> ${target}`);
