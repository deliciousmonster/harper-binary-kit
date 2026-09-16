// Getting the packages onto the registry, and the three silences this replaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { advanceLatest, distTag, isNewer, publishAll } from '../../src/publish.js';
import { confirmPublished, isPublished, readBackLine, versionUrl } from '../../src/published.js';

/**
 * Only the two fields the publish path reads. Cast because a full PlatformPackage carries a target, a variant
 * and its binaries, and none of that is what publishing does.
 *
 * @type {readonly import('../../src/packages.js').PlatformPackage[]}
 */
const PACKAGES = /** @type {any} */ ([
	{ name: '@x/a-linux-x86_64', dirName: 'linux-x86_64' },
	{ name: '@x/a-probe-linux-x86_64', dirName: 'probe-linux-x86_64' },
	{ name: '@x/a-macos-arm64', dirName: 'macos-arm64' },
]);

/** A fetch that answers whatever the case needs, without the rest of the Response surface. */
const answering = (/** @type {(url: string) => any} */ reply) =>
	/** @type {typeof globalThis.fetch} */ (/** @type {any} */ (async (/** @type {any} */ url) => reply(String(url))));

test('a prerelease publishes under its own identifier, a stable one under latest', () => {
	assert.equal(distTag('7.82.1-next.10'), 'next');
	assert.equal(distTag('1.0.0-rc.3'), 'rc');
	assert.equal(distTag('1.0.0'), 'latest');
});

// npm would read a numeric tag as a version, so this is refused rather than published under something that
// silently means a different thing.
test('NEGATIVE: a numeric prerelease identifier is refused, and the message names the fix', () => {
	assert.throws(() => distTag('1.2.3-0'), /cannot start with a digit/);
	assert.throws(() => distTag('1.2.3-0'), /1\.2\.3-next\.0/);
});

// The 2026-09-11 release: four published, the fifth 404'd, and the loop stopped. Five names sat a version
// behind and the run said nothing about whether they would have worked.
test('NEGATIVE: one failure does not stop the packages behind it', () => {
	/** @type {string[]} */
	const attempted = [];
	const run = (/** @type {string} */ _command, /** @type {string[]} */ args, /** @type {any} */ options) => {
		attempted.push(options.cwd);
		if (options.cwd.endsWith('probe-linux-x86_64')) throw new Error('404 Not Found - PUT');
		return '';
	};
	const { published, failed, lines } = publishAll({
		root: '/repo',
		packages: PACKAGES,
		version: '1.0.0-next.1',
		run,
	});
	assert.equal(attempted.length, 3, 'the loop stopped early');
	assert.deepEqual(published, ['@x/a-linux-x86_64', '@x/a-macos-arm64']);
	assert.deepEqual(
		failed.map((f) => f.name),
		['@x/a-probe-linux-x86_64']
	);
	// A 404 on PUT is npm's answer for a name with no trusted publisher, which reads identically to a missing
	// package. The line has to say so or the next person re-runs the release to find out.
	assert.ok(lines.some((line) => line.includes('trusted publisher')));
});

// Adopting the kit dropped the old workflow's "Publish main package" step, so v7.82.1-next.11 put eight
// platform packages on the registry and no root. npm resolved the version to nothing installable.
test('the root package is published too, from the repo, after the platform set', () => {
	/** @type {string[]} */
	const cwds = [];
	const { published } = publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0-next.1',
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			cwds.push(String(options.cwd));
			return '';
		},
	});
	assert.ok(published.includes('@x/a'), 'the root package was never published');
	assert.equal(cwds.at(-1), '/repo', 'the root publishes from the repo root, and last');
	assert.equal(cwds.length, PACKAGES.length + 1);
});

// A root on the registry ahead of its binaries is the worse failure: npm installs it and resolves its
// optionalDependencies to versions that are not there.
test('NEGATIVE: the root is held back when any platform package did not publish', () => {
	const { published, failed, lines } = publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0-next.1',
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			if (String(options.cwd).includes('probe')) throw new Error('404');
			return '';
		},
	});
	assert.ok(!published.includes('@x/a'), 'the root went out over a failed platform package');
	assert.equal(failed.length, 1, 'the root must not be counted as a failure of its own');
	assert.ok(lines.some((line) => line.includes('did not publish @x/a@1.0.0-next.1')));
});

test('every package is published under the tag the version derives', () => {
	/** @type {string[]} */
	const tags = [];
	publishAll({
		root: '/repo',
		packages: PACKAGES,
		version: '2.0.0-beta.4',
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			tags.push(String(args[args.indexOf('--tag') + 1]));
			return '';
		},
	});
	assert.deepEqual(tags, ['beta', 'beta', 'beta']);
});

test('latest moves to this release', () => {
	/** @type {string[]} */
	const moved = [];
	const { failed } = advanceLatest({
		names: ['@x/a', '@x/a-linux-x86_64'],
		version: '1.2.0',
		currentLatest: () => '1.1.0',
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			moved.push(String(args[2]));
			return '';
		},
	});
	assert.deepEqual(moved, ['@x/a@1.2.0', '@x/a-linux-x86_64@1.2.0']);
	assert.deepEqual(failed, []);
});

// Forward only: a re-run of an older tag must not walk latest backwards over the release that followed it.
test('NEGATIVE: latest is never walked backwards', () => {
	/** @type {string[]} */
	const moved = [];
	const { left, lines } = advanceLatest({
		names: ['@x/a'],
		version: '1.1.0',
		currentLatest: () => '1.2.0',
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			moved.push(String(args[2]));
			return '';
		},
	});
	assert.deepEqual(moved, [], 'an older re-run moved latest back');
	assert.deepEqual(left, ['@x/a']);
	assert.match(String(lines[0]), /newer than 1\.1\.0/);
});

// A prerelease sorts below the release it precedes, so 1.2.3 replacing 1.2.3-next.9 is forward.
test('a stable release is newer than its own prereleases', () => {
	assert.equal(isNewer('1.2.3', '1.2.3-next.9'), true);
	assert.equal(isNewer('1.2.3-next.9', '1.2.3'), false);
	assert.equal(isNewer('7.82.1-next.10', '7.82.1-next.9'), true, 'next.10 sorts above next.9, not below it');
	assert.equal(isNewer('7.82.1-next.9', '7.82.1-next.10'), false);
	assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

// The E401 this hit for real: OIDC covers `npm publish` and not `dist-tag add`. Failing loudly with the
// commands is the difference between a stale latest somebody fixes and one nobody knows about.
test('NEGATIVE: a refused dist-tag write is reported with the command to run by hand', () => {
	const { failed, commands, lines } = advanceLatest({
		names: ['@x/a', '@x/a-linux-x86_64'],
		version: '1.2.0',
		currentLatest: () => null,
		run: () => {
			throw new Error('E401 Unable to authenticate');
		},
	});
	assert.deepEqual(failed, ['@x/a', '@x/a-linux-x86_64']);
	assert.deepEqual(commands, ['npm dist-tag add @x/a@1.2.0 latest', 'npm dist-tag add @x/a-linux-x86_64@1.2.0 latest']);
	assert.ok(lines.every((line) => line.includes('could not move latest') || line.includes('latest ->')));
});

test('the read-back asks the registry for the exact version', () => {
	assert.equal(
		versionUrl('@x/a-linux-x86_64', '1.0.0-next.1'),
		'https://registry.npmjs.org/@x%2Fa-linux-x86_64/1.0.0-next.1'
	);
});

test('a version the registry serves reads as published', async () => {
	const { published } = await isPublished('@x/a', '1.0.0', {
		fetch: answering(() => ({ status: 200, ok: true, json: async () => ({ name: '@x/a', version: '1.0.0' }) })),
	});
	assert.equal(published, true);
});

test('NEGATIVE: a 404 is the only answer that reads as not published', async () => {
	const missing = await isPublished('@x/a', '1.0.0', { fetch: answering(() => ({ status: 404, ok: false })) });
	assert.equal(missing.published, false);
	assert.match(missing.detail, /has no @x\/a@1\.0\.0/);
});

// Telling somebody to republish something already published is worse than saying nothing, so everything that
// is not a clean 404 or a clean match reports why it could not tell rather than asserting absence.
test('NEGATIVE: a registry that will not answer is "could not tell", with the reason', async () => {
	/** @type {[(url: string) => any, RegExp][]} */
	const cases = [
		[() => ({ status: 503, ok: false }), /answered 503/],
		[
			() => {
				throw new Error('ETIMEDOUT');
			},
			/could not reach the registry: ETIMEDOUT/,
		],
		[
			() => ({
				status: 200,
				ok: true,
				json: async () => {
					throw new Error('Unexpected end of JSON input');
				},
			}),
			/did not parse/,
		],
		[
			() => ({ status: 200, ok: true, json: async () => ({ name: '@x/a', version: '0.9.0' }) }),
			/answered with @x\/a@0\.9\.0/,
		],
	];
	for (const [respond, expected] of cases) {
		const answer = await isPublished('@x/a', '1.0.0', { fetch: answering(respond) });
		assert.equal(answer.published, false);
		assert.match(answer.detail, expected);
	}
});

/** A registry answering 200 for every name, with `absent` 404 until it has been asked `appearAfter` times. */
function registry(/** @type {string[]} */ absent = [], appearAfter = Infinity) {
	const asked = new Map();
	const fetch = answering((url) => {
		const name = decodeURIComponent(String(url.split('/').at(-2)));
		const count = (asked.get(name) ?? 0) + 1;
		asked.set(name, count);
		if (absent.includes(name) && count <= appearAfter) return { status: 404, ok: false };
		return { status: 200, ok: true, json: async () => ({ name, version: '1.0.0' }) };
	});
	return { fetch, asked };
}

/** A clock that advances only when the code under test waits, so a 20-minute deadline costs no real time. */
function fakeClock() {
	let t = 0;
	return { now: () => t, wait: async (/** @type {number} */ ms) => void (t += ms) };
}

test('a release is confirmed package by package, and names the ones that are not there', async () => {
	const { ok, missing } = await confirmPublished({
		names: ['@x/a', '@x/a-linux-x86_64', '@x/a-probe-linux-x86_64'],
		version: '1.0.0',
		fetch: registry(['@x/a-probe-linux-x86_64']).fetch,
		...fakeClock(),
	});
	assert.equal(ok, false);
	assert.deepEqual(missing, ['@x/a-probe-linux-x86_64']);
});

// The defect this is for: on 2026-09-14 the read-back ran one second after the publish and called 5 of 8
// packages missing. All 8 were there; the last took 13 minutes to serve.
test('a package the registry has not served yet is waited for, not called missing', async () => {
	const { fetch, asked } = registry(['@x/a-probe-linux-x86_64'], 3);
	const { ok, missing } = await confirmPublished({
		names: ['@x/a', '@x/a-probe-linux-x86_64'],
		version: '1.0.0',
		fetch,
		...fakeClock(),
	});
	assert.equal(ok, true, `it gave up on a package that did appear: ${missing.join(', ')}`);
	assert.equal(asked.get('@x/a-probe-linux-x86_64'), 4, 'it should have asked until the answer changed');
	assert.equal(asked.get('@x/a'), 1, 'a package already served should not be asked again');
});

// The retry must not turn a real failure into a pass, which is the whole risk of adding one.
test('NEGATIVE: a package that never appears still fails, and the wait is bounded', async () => {
	const clock = fakeClock();
	const { fetch, asked } = registry(['@x/a-probe-linux-x86_64']);
	const { ok, missing } = await confirmPublished({
		names: ['@x/a-probe-linux-x86_64'],
		version: '1.0.0',
		fetch,
		timeoutMs: 60_000,
		intervalMs: 15_000,
		...clock,
	});
	assert.equal(ok, false);
	assert.deepEqual(missing, ['@x/a-probe-linux-x86_64']);
	assert.equal(clock.now(), 60_000, 'it waited past its own deadline');
	assert.equal(asked.get('@x/a-probe-linux-x86_64'), 5, 'four waits of 15s, and a read before each');
});

// 7.82.1-next.15 published all nine packages and then failed its own release, because the read-back gave up on
// one of them at twenty minutes and a failed step skips the one that moves `latest`. The tag sat on next.14
// until it was moved by hand. An unconfirmed read-back has to leave the job green and the operator informed.
test('an unconfirmed read-back reads as a wait, not a failed release', () => {
	const line = readBackLine(['@x/a-probe-macos-arm64'], '7.82.1-next.15');
	assert.match(line, /@x\/a-probe-macos-arm64/, 'the operator cannot act on a warning that names nothing');
	assert.match(line, /7\.82\.1-next\.15/);
	assert.match(line, /npm accepted every publish/, 'it must say the release itself is not in doubt');
	assert.match(line, /latest/, 'and point at the step that decides');
	assert.doesNotMatch(line, /fail(ed|ure)\b(?!s if)/i, 'nothing here is a failure yet');
});

test('a confirmed read-back claims nothing is missing', () => {
	const line = readBackLine([], '7.82.1-next.15');
	assert.equal(line, 'every package of 7.82.1-next.15 is on the registry');
	assert.doesNotMatch(line, /not served|absent|yet/);
});

// The ceiling is the only thing separating a slow read from an absent package, and next.15 walked past a
// twenty-minute one. A default that drifts back down re-opens exactly that failure.
test('the read-back waits half an hour before it gives up', async () => {
	const clock = fakeClock();
	const { fetch } = registry(['@x/a']);
	await confirmPublished({ names: ['@x/a'], version: '1.0.0', fetch, ...clock });
	assert.equal(clock.now(), 30 * 60_000, 'the default ceiling moved');
});
