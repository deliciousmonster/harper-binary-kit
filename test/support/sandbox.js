// Scratch space for tests that stage real packages and read them back.
//
// Kept small on purpose: a helper that grows becomes a second thing to understand before reading a test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A temp directory for `run`'s duration, removed however it ends. @param {string} prefix @param {(dir: string) => any} run */
export async function withTempDir(prefix, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The one element a fixture is supposed to have produced.
 *
 * Destructuring an array gives `T | undefined` under a strict config, and a test that silently ran against
 * `undefined` because its own fixture produced nothing is a test that proves nothing. This says so instead.
 *
 * @template T @param {readonly T[]} list @param {string} what @param {number} [index]
 * @returns {T}
 */
export function one(list, what, index = 0) {
	const found = list[index];
	if (found === undefined) throw new Error(`the fixture produced no ${what} at index ${index}`);
	return found;
}
