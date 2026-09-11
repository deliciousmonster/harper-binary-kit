// The package set a release publishes, derived from one declaration.
//
// Every step used to rediscover it: the workflow globbed `npm/*/` to publish, globbed `agent-*` to name the
// release assets, and reconstructed `build/<target>/bin` in shell. Three places that must agree with the
// declaration and nothing making them, which is how a target that silently failed to build became a package
// that was silently not published.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allPackages, binariesFor, expectedFiles, optionalDependencies, packagesFor } from '../../src/packages.js';
import { currentTargetName, target, targets } from '../../src/targets.js';
import { one } from '../support/sandbox.js';

const CONFIG = {
	scope: '@x/agent',
	variants: [
		{ suffix: '' },
		{ suffix: '-probe', optional: true, carries: 'It carries the probe.', extraDirs: ['share/probe'] },
	],
	binaries: [
		{ shipsAs: 'agent', symbol: 'RUNTIME_MARKER' },
		{ shipsAs: 'trace-agent' },
		{ shipsAs: 'probe', variant: '-probe', onlyOn: ['linux-x86_64', 'linux-arm64'] },
	],
};
const LINUX = target('linux-x86_64');
const MAC = target('macos-arm64');

test('a target publishes one package per variant that carries something', () => {
	const names = packagesFor(CONFIG, LINUX).map((pkg) => pkg.name);
	assert.deepEqual(names, ['@x/agent-linux-x86_64', '@x/agent-probe-linux-x86_64']);
});

// A description claiming a binary the package does not have, and a package promising an accessor for a file
// it never staged, both come from publishing a variant a target carries nothing for.
test('NEGATIVE: a variant with nothing to carry on this target publishes no package', () => {
	const names = packagesFor(CONFIG, MAC).map((pkg) => pkg.name);
	assert.deepEqual(names, ['@x/agent-macos-arm64'], 'macOS has no probe, so it must publish no probe package');
	assert.deepEqual(binariesFor(CONFIG.binaries, one(CONFIG.variants, 'variant', 1), MAC), []);
});

test('the directory name is the npm name without the scope, so the two cannot drift', () => {
	for (const pkg of allPackages(CONFIG, targets(['linux-x86_64', 'macos-arm64']))) {
		assert.ok(pkg.name.endsWith(pkg.dirName), `${pkg.name} is staged in npm/${pkg.dirName}`);
	}
});

test('npm is told the os and cpu it filters the install on', () => {
	const base = one(packagesFor(CONFIG, LINUX), 'package');
	assert.equal(base.target.npmOs, 'linux');
	assert.equal(base.target.npmCpu, 'x64');
	const mac = one(packagesFor(CONFIG, MAC), 'package');
	assert.equal(mac.target.npmOs, 'darwin', 'the label is macos and npm calls it darwin');
	assert.equal(mac.target.npmCpu, 'arm64');
});

// The split's whole purpose. An add-on listed as an optionalDependency is installed on every matching host,
// which is the cost it exists to refuse.
test('NEGATIVE: an add-on variant is never an optionalDependency', () => {
	const pinned = optionalDependencies(CONFIG, targets(['linux-x86_64', 'macos-arm64']), '2.0.0');
	assert.deepEqual(Object.keys(pinned).sort(), ['@x/agent-linux-x86_64', '@x/agent-macos-arm64']);
	assert.ok(!Object.keys(pinned).some((name) => name.includes('probe')));
	assert.deepEqual(Object.values(pinned), ['2.0.0', '2.0.0']);
});

// One version across the release, because the base package pins its optionalDependencies at exactly this one:
// a platform package a version behind is not installed, it is refused as unresolvable.
test('every optional dependency is pinned at the release version, never a range', () => {
	const pinned = optionalDependencies(CONFIG, targets(['linux-x86_64']), '7.82.1-next.10');
	assert.deepEqual(Object.values(pinned), ['7.82.1-next.10']);
	assert.ok(!Object.values(pinned).some((v) => /[\^~*]/.test(v)));
});

test('the files a tarball must carry are derived from what the package declares', () => {
	const packages = packagesFor(CONFIG, LINUX);
	const base = one(packages, 'base package');
	const probe = one(packages, 'probe package', 1);
	assert.deepEqual(expectedFiles(base).sort(), ['bin/agent', 'bin/trace-agent', 'index.js', 'package.json']);
	assert.deepEqual(expectedFiles(probe).sort(), ['bin/probe', 'index.js', 'package.json']);
});

test('Windows binaries carry the suffix, in the package and in the expected files', () => {
	const base = one(packagesFor(CONFIG, target('windows-x86_64')), 'package');
	assert.deepEqual(expectedFiles(base).sort(), ['bin/agent.exe', 'bin/trace-agent.exe', 'index.js', 'package.json']);
});

// A label nothing recognises would publish a package with an `os` field npm never matches: it installs on no
// host and reports nothing. macos-x86_64 is NOT that case - it is a real pair this consumer happens not to
// build for, and which target list a consumer declares is the consumer's to say.
test('NEGATIVE: a label naming no real host is refused, and the refusal lists the real ones', () => {
	assert.throws(() => target('solaris-arm64'), /unknown target/);
	assert.throws(() => target('linux-ppc64'), /unknown target/);
	assert.throws(() => target('linux'), /unknown target/);
	assert.throws(() => target('bsd-arm64'), /linux-x86_64/);
	// A pair nobody in this repo builds is still a pair npm understands, so the kit does not refuse it.
	assert.equal(target('macos-x86_64').npmOs, 'darwin');
});

test('this host has a target label, or none, and never a guess', () => {
	assert.equal(currentTargetName('darwin', 'arm64'), 'macos-arm64');
	assert.equal(currentTargetName('win32', 'x64'), 'windows-x86_64');
	assert.equal(currentTargetName('linux', 'arm64'), 'linux-arm64');
	assert.equal(currentTargetName('freebsd', 'x64'), null);
	assert.equal(currentTargetName('linux', 'ppc64'), null);
});

// The same binary reaches the kernel by a different mechanism per platform: precompiled eBPF objects on
// Linux, packet capture on macOS, signed drivers on Windows. Two of the three ship no objects, so a
// variant-wide directory would refuse to stage them, and shipping the Linux ones to either would be 42 MB
// neither can load.
test('an extra directory can name the targets that carry it', () => {
	const config = {
		scope: '@x/agent',
		variants: [
			{
				suffix: '-probe',
				optional: true,
				extraDirs: [{ dir: 'share/system-probe', onlyOn: ['linux-x86_64', 'linux-arm64'] }],
			},
		],
		binaries: [{ shipsAs: 'system-probe', variant: '-probe' }],
	};
	assert.deepEqual(one(packagesFor(config, target('linux-x86_64')), 'package').extraDirs, ['share/system-probe']);
	assert.deepEqual(
		one(packagesFor(config, target('macos-arm64')), 'package').extraDirs,
		[],
		'a target that carries no objects must not be asked to stage a directory it has none of'
	);
});

test('a plain string extra directory is carried on every target the variant publishes on', () => {
	const config = {
		scope: '@x/agent',
		variants: [{ suffix: '-probe', optional: true, extraDirs: ['share/anything'] }],
		binaries: [{ shipsAs: 'system-probe', variant: '-probe' }],
	};
	for (const name of ['linux-x86_64', 'macos-arm64', 'windows-x86_64']) {
		assert.deepEqual(one(packagesFor(config, target(name)), 'package').extraDirs, ['share/anything'], name);
	}
});
