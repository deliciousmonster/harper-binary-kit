// @ts-check
// Getting the packages onto the registry, and saying plainly what did not get there.
//
// Three things go wrong here and each one used to be silent.
//
// A publish loop that stops at the first failure leaves the rest unattempted and unreported: on 2026-09-11 a
// release published four packages, hit a 404 on the fifth, and stopped, so five names sat a version behind
// and nothing said whether they would have worked. npm answers a publish to a name with no trusted publisher
// with 404 rather than 403, so "not configured" and "not there" read identically and trying is the only way
// to know. So every package is attempted and the failures are collected.
//
// A prerelease published without `--tag` is refused by npm 11, and published WITH the wrong tag takes
// `latest` on a package's first publish whatever the tag says. So the tag is derived from the version and
// never guessed.
//
// And `latest` is only ever assigned on a first publish, so on a package published only under a prerelease
// tag it freezes at whatever version created the name. Measured on 2026-09-11: ten packages served next.10
// under `next` and next.6 under `latest`, four releases behind, and `latest` is what npmjs.com shows and what
// a bare `npm install` gets.

import { execFileSync } from 'node:child_process';

import { packageDir } from './layout.js';

const NEEDS_SHELL = process.platform === 'win32';

/**
 * The dist-tag a version publishes under: its prerelease identifier, or `latest` for a stable one.
 *
 * A tag cannot start with a digit, because npm would read it as a version. `1.2.3-0` has an identifier of
 * `0`, so it is named rather than guessed at, and the refusal names the fix.
 *
 * @param {string} version @returns {string}
 */
export function distTag(version) {
	const identifier = version.split('-')[1]?.split('.')[0];
	if (identifier === undefined) return 'latest';
	if (/^\d/.test(identifier)) {
		throw new Error(
			`version ${version} has the prerelease identifier "${identifier}", and a dist-tag cannot start with a ` +
				`digit: npm would read it as a version. Name the prerelease (1.2.3-next.0, 1.2.3-rc.0) and re-tag.`
		);
	}
	return identifier;
}

/**
 * Publish every package, attempting all of them.
 *
 * @param {object} options
 * @param {string} options.root @param {readonly import('./packages.js').PlatformPackage[]} options.packages
 * @param {string} options.version @param {string} [options.tag]
 * @param {(command: string, args: string[], options: any) => unknown} [options.run]
 * @returns {{ published: string[], failed: { name: string, reason: string }[], lines: string[] }}
 */
export function publishAll({ root, packages, version, tag = distTag(version), run = execFileSync }) {
	const published = [];
	const failed = [];
	const lines = [];
	for (const pkg of packages) {
		try {
			run('npm', ['publish', '--access', 'public', '--tag', tag], {
				cwd: packageDir(root, pkg.dirName),
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			published.push(pkg.name);
			lines.push(`published ${pkg.name}@${version} under ${tag}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failed.push({ name: pkg.name, reason });
			lines.push(
				`FAILED ${pkg.name}@${version}: ${reason}. A 404 on PUT means this name has no trusted publisher for ` +
					`this repository and workflow; create one and re-run.`
			);
		}
	}
	return { published, failed, lines };
}

/**
 * Point `latest` at this release, forward only.
 *
 * Forward only because a re-run of an older tag must not walk `latest` backwards, and because a stable release
 * published after a prerelease is the one case where leaving it alone is right.
 *
 * Whether the job's credentials cover this at all is the open question: OIDC is documented for `npm publish`,
 * and on 2026-09-11 a trusted-publisher job that had just published ten packages was answered E401 for every
 * `dist-tag add`. So a failure here is reported with the exact commands rather than swallowed, and the caller
 * decides whether a stale `latest` fails the release.
 *
 * @param {object} options
 * @param {readonly string[]} options.names @param {string} options.version
 * @param {(command: string, args: string[], options: any) => unknown} [options.run]
 * @param {(name: string) => string | null} [options.currentLatest] What `latest` says now, or null.
 * @returns {{ moved: string[], left: string[], failed: string[], lines: string[], commands: string[] }}
 */
export function advanceLatest({ names, version, run = execFileSync, currentLatest = readLatest }) {
	const moved = [];
	const left = [];
	const failed = [];
	const lines = [];
	const commands = [];
	for (const name of names) {
		const current = currentLatest(name);
		if (current && current !== version && isNewer(current, version)) {
			left.push(name);
			lines.push(`left ${name} at latest=${current}, which is newer than ${version}`);
			continue;
		}
		try {
			run('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'], {
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			moved.push(name);
			lines.push(`latest -> ${version} for ${name}`);
		} catch (error) {
			failed.push(name);
			commands.push(`npm dist-tag add ${name}@${version} latest`);
			lines.push(`could not move latest for ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { moved, left, failed, lines, commands };
}

/** @param {string} name @returns {string | null} */
function readLatest(name) {
	try {
		return String(
			execFileSync('npm', ['view', name, 'dist-tags.latest'], {
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
		).trim();
	} catch {
		// A package with no `latest` at all, or one that is not published yet. Either way nothing to compare.
		return null;
	}
}

/**
 * Whether `a` is a later release than `b`, on semver's own rules: numeric cores compare segment by segment,
 * and a prerelease sorts BELOW the release it precedes, so 1.2.3 is newer than 1.2.3-next.9.
 *
 * @param {string} a @param {string} b
 */
export function isNewer(a, b) {
	const [coreA, preA] = split(a);
	const [coreB, preB] = split(b);
	for (let i = 0; i < 3; i++) {
		const difference = (coreA[i] ?? 0) - (coreB[i] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	if (preA === null && preB === null) return false;
	if (preA === null) return true;
	if (preB === null) return false;
	return comparePrerelease(preA, preB) > 0;
}

/** @param {string} version @returns {[number[], string | null]} */
function split(version) {
	const [core = '', ...rest] = version.split('-');
	return [core.split('.').map(Number), rest.length ? rest.join('-') : null];
}

/** Dot-separated identifiers: numeric ones compare numerically, and a numeric one sorts below a text one. @param {string} a @param {string} b */
function comparePrerelease(a, b) {
	const left = a.split('.');
	const right = b.split('.');
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i];
		const y = right[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
		if (numeric) {
			if (Number(x) !== Number(y)) return Number(x) - Number(y);
			continue;
		}
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}
