// The CLI as a release actually invokes it: a real repo on disk, the real argv, the file read back. `deps
// --write` was accepted and ignored for every release up to 7.82.1-next.11, and nothing here covered it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTempDir } from '../support/sandbox.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

const CONFIG = `export default {
	scope: '@x/agent',
	targets: ['linux-x86_64', 'macos-arm64'],
	variants: [{ suffix: '' }],
	binaries: [{ shipsAs: 'agent' }],
};
`;

/** A consumer repo the CLI can be pointed at, with `version` and whatever optionalDependencies are given. */
function repo(
	/** @type {string} */ dir,
	/** @type {string} */ version,
	/** @type {Record<string, string>} */ optionalDependencies
) {
	writeFileSync(join(dir, 'binary-kit.config.js'), CONFIG);
	writeFileSync(
		join(dir, 'package.json'),
		`${JSON.stringify({ name: '@x/agent', version, optionalDependencies }, null, '\t')}\n`
	);
}

const run = (/** @type {string} */ dir, /** @type {string[]} */ argv) =>
	execFileSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: 'utf-8' });

const manifest = (/** @type {string} */ dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));

test('deps --write puts the release version on every optional dependency', () =>
	withTempDir('kit-cli-deps-', async (dir) => {
		repo(dir, '2.0.0-next.3', { '@x/agent-linux-x86_64': '1.0.0-next.1' });
		run(dir, ['deps', '--write']);
		assert.deepEqual(manifest(dir).optionalDependencies, {
			'@x/agent-linux-x86_64': '2.0.0-next.3',
			'@x/agent-macos-arm64': '2.0.0-next.3',
		});
	}));

// `npm version` runs this as a lifecycle script, and a root published with the previous release's binaries
// declared installs an agent whose version and binaries disagree.
test('deps --write leaves the rest of the manifest alone', () =>
	withTempDir('kit-cli-keep-', async (dir) => {
		repo(dir, '2.0.0-next.3', { '@x/agent-linux-x86_64': '1.0.0-next.1' });
		run(dir, ['deps', '--write']);
		const written = manifest(dir);
		assert.equal(written.name, '@x/agent');
		assert.equal(written.version, '2.0.0-next.3');
		assert.match(readFileSync(join(dir, 'package.json'), 'utf-8'), /^\t"name"/m, 'it reindented the manifest');
	}));

test('NEGATIVE: deps without --write prints and changes nothing', () =>
	withTempDir('kit-cli-dry-', async (dir) => {
		repo(dir, '2.0.0-next.3', { '@x/agent-linux-x86_64': '1.0.0-next.1' });
		const before = readFileSync(join(dir, 'package.json'), 'utf-8');
		const printed = run(dir, ['deps']);
		assert.match(printed, /2\.0\.0-next\.3/, 'it should still print the block');
		assert.equal(readFileSync(join(dir, 'package.json'), 'utf-8'), before);
	}));
