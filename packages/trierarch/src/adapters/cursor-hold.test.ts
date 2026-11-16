/** A real hold and an isolated stand-in for the captured Cursor CLI process protocol. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId } from '../../test/support/in-memory.js';
import { aShortHome } from '../../test/support/short-home.js';
import type { SessionRuntime } from '../core/ports.js';
import { createHoldRuntime } from './hold-runtime.js';

let folder: string;
let sessions: string;
let runtime: SessionRuntime;
let shipId: ShipId;

beforeEach(() => {
  folder = aShortHome('cursor-folder');
  sessions = aShortHome('cursor-holds');
  shipId = newId('ship');
  runtime = createHoldRuntime({ sessions, program: TRIERARCH_PROGRAM, version: 'test', platform: process.platform });
  writeFileSync(join(folder, 'agent.cjs'), `const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args.at(-1);
fs.appendFileSync('starts.jsonl', JSON.stringify(args)+'\\n');
process.stdin.resume();
process.stdin.on('end', () => {
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:'chat-cursor'}));
 if (prompt === 'fail') {console.error('Cursor model call failed');setTimeout(()=>process.exit(1),100);return;}
 if (prompt === 'slow') {console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}]}}));setInterval(()=>{},1000);return;}
 console.log(JSON.stringify({type:'result',is_error:false,result:'done',session_id:'chat-cursor'}));
 setTimeout(()=>process.exit(0),150);
});
process.on('SIGINT',()=>process.exit(130));
`);
});
afterEach(async () => {
  await runtime.stop(shipId);
  rmSync(folder, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});
const events = () => runtime.events(shipId);
const starts = () => readFileSync(join(folder, 'starts.jsonl'), 'utf8').trim().split('\n').map((line): unknown => JSON.parse(line));
async function start(prompt: string) {
  await runtime.start({ shipId, folder, harness: 'cursor', command: [process.execPath, join(folder, 'agent.cjs'), '--output-format=stream-json', '--trust', '--print', '--', prompt] });
}

describe('Cursor held as a process per turn (CC3, CC4)', () => {
  it('keeps busy through a result until the process exits, then resumes the chat on the next line', async () => {
    await start('first');
    await expect.poll(async () => (await events()).some((line) => line.includes('"state":"idle"'))).toBe(true);
    await runtime.send({ shipId, line: '-next' });
    await expect.poll(() => starts().length).toBe(2);
    expect(starts()[1]).toEqual(['--output-format=stream-json', '--trust', '--print', '--resume=chat-cursor', '--', '-next']);
    await expect.poll(async () => (await events()).filter((line) => line.includes('"state":"idle"')).length).toBe(2);
    expect((await events()).filter((line) => line.includes('"type":"aeolus.turn"'))).toEqual([
      '{"type":"aeolus.turn","state":"busy"}', '{"type":"aeolus.turn","state":"idle","exitStatus":0}',
      '{"type":"aeolus.turn","state":"busy"}', '{"type":"aeolus.turn","state":"idle","exitStatus":0}',
    ]);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('retains stderr and exits the hold for an unexpectedly failed turn', async () => {
    await start('fail');
    await expect.poll(() => runtime.list()).toEqual([{ shipId, status: 'exited' }]);
    expect(await events()).toContain('{"type":"aeolus.stderr","line":"Cursor model call failed"}');
    expect(await events()).toContain('{"type":"aeolus.turn","state":"idle","exitStatus":1}');
  });

  it('keeps the hold after its own SIGINT even when Cursor handles the signal and exits 130', async () => {
    await start('slow');
    await expect.poll(async () => (await events()).some((line) => line.includes('"type":"assistant"'))).toBe(true);
    await runtime.interrupt(shipId);
    await runtime.send({ shipId, line: 'forced' });
    await expect.poll(() => starts().length).toBe(2);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    expect(starts()[1]).toContain('--resume=chat-cursor');
  });
});
