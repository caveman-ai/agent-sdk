import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION, HARNESS_EXIT_CODES, ZERO_USAGE, CavemanError } from '../dist/index.js';

test('protocol exports canonical constants and error types', () => {
  assert.equal(PROTOCOL_VERSION, '1.0.0');
  assert.equal(HARNESS_EXIT_CODES.PARKED_WAITING, 5);
  assert.equal(HARNESS_EXIT_CODES.PARKED_IDLE, 6);
  assert.equal(ZERO_USAGE.cost_usd, 0);
  const err = new CavemanError('budget_reached', 'stopped');
  assert.equal(err.code, 'budget_reached');
});

test('all shipped JSON schemas parse cleanly', () => {
  const dir = resolve(import.meta.dirname, '../schemas');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2, 'expected JSON schemas');
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    assert.equal(typeof parsed, 'object');
  }
});
