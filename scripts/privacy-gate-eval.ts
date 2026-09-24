/**
 * Scores the privacy gate against hand-labeled screen frames.
 *
 *   AMBIENT_GATE_API_KEY=... npx tsx scripts/privacy-gate-eval.ts [threshold]
 *
 * Fixtures live OUTSIDE the repo at ~/.ambient/eval/labeled-frames.json (they
 * hold real screen text): [{ appName, windowName, text, timestamp, frameId, private }].
 * Prints frame ids and scores only, never text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrivacyGate, DEFAULT_THRESHOLD } from '../src/analysis/PrivacyGate.js';
import type { OcrEntry } from '../src/screenpipe/types.js';

interface LabeledFrame extends OcrEntry {
  frameId: number;
  private: boolean;
}

async function main(): Promise<void> {
  const file = path.join(os.homedir(), '.ambient/eval/labeled-frames.json');
  const frames = JSON.parse(fs.readFileSync(file, 'utf8')) as LabeledFrame[];
  const threshold = process.argv[2] ? Number(process.argv[2]) : DEFAULT_THRESHOLD;
  const gate = new PrivacyGate({ apiKey: process.env.AMBIENT_GATE_API_KEY, threshold });
  if (!gate.hasKey) throw new Error('AMBIENT_GATE_API_KEY is not set');

  let caught = 0, missed = 0, falseAlarms = 0, errors = 0;
  for (const f of frames) {
    const v = await gate.check(f);
    if (v.reason === 'error') errors++;
    const flag = v.withheld;
    if (f.private && flag) caught++;
    else if (f.private) missed++;
    else if (flag) falseAlarms++;
    const mark = f.private ? (flag ? 'caught' : 'MISSED') : flag ? 'false alarm' : 'ok';
    console.log(`${String(f.frameId).padStart(6)}  ${(v.maxScore ?? NaN).toFixed(2)}  ${mark}`);
  }
  const priv = frames.filter((f) => f.private).length;
  console.log(
    `\nthreshold ${threshold}: caught ${caught}/${priv} private, missed ${missed}, ` +
      `false alarms ${falseAlarms}/${frames.length - priv}, check errors ${errors}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
