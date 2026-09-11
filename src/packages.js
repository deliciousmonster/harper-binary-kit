// @ts-check
// How the binaries are split across npm packages.
//
// One package per target at least, and often two. The base package is an optionalDependency of the component,
// so npm installs it on every host whose `os` and `cpu` match and skips it silently everywhere else, which is
// exactly the behaviour wanted: a customer gets their platform's binaries and pays for no others.
//
// A second variant exists for the binaries most nodes never run. Making those an optionalDependency too would
// charge every install for them, and the ones this was built for are large: privileged binaries with their own
// precompiled objects, inert until a host is configured for them. So an add-on variant is NOT an
// optionalDependency, is installed by name, and is asked for at resolve time like any other.
//
// Nothing is dropped and nothing is paid for twice. A target that has no binaries for a variant publishes no
// package for it, so a description never claims a binary its package does not carry.

import { binaryFilename } from './targets.js';

/**
 * @typedef {object} Binary
 * @property {string} shipsAs The filename it ships under, before the platform's suffix. Also the name a
 *   consumer asks `getBinaryPath` for, which is why it is the one identifier that must not drift.
 * @property {string} [variant] Which variant carries it. Defaults to the base variant.
 * @property {readonly string[]} [onlyOn] Target names that carry it; absent means every target.
 * @property {string} [symbol] A string that must be present in the shipped file. The publish gate reads the
 *   packed tarball for it, which is how a binary built without the thing it exists for is caught.
 */

/**
 * @typedef {object} Variant
 * @property {string} suffix Appended to the scope before the target label. Empty for the base variant.
 * @property {boolean} [optional] True for a variant installed by name rather than by dependency resolution.
 * @property {string} [carries] Why it is separate, for the error a consumer reads when it is not installed.
 * @property {readonly string[]} [extraDirs] Directories staged beside `bin/`, relative to the build tree.
 */

/**
 * @typedef {object} PlatformPackage
 * @property {string} name The npm name.
 * @property {string} dirName Directory under `npm/`. The npm name's last segment, so the two cannot drift.
 * @property {import('./targets.js').Target} target
 * @property {Variant} variant
 * @property {Binary[]} binaries
 * @property {boolean} optionalDependency
 * @property {readonly string[]} extraDirs
 */

/** Whether a binary ships for a target at all. @param {Binary} binary @param {import('./targets.js').Target} on */
export const shipsOn = (binary, on) => !binary.onlyOn || binary.onlyOn.includes(on.name);

/** The binaries one variant carries on one target. @param {readonly Binary[]} binaries @param {Variant} variant @param {import('./targets.js').Target} on */
export const binariesFor = (binaries, variant, on) =>
	binaries.filter((binary) => (binary.variant ?? '') === variant.suffix && shipsOn(binary, on));

/**
 * Every package one target publishes. A variant with nothing to carry on this target publishes nothing, so a
 * host that has no system-probe does not get an empty package promising one.
 *
 * @param {object} config
 * @param {string} config.scope The base package name; every platform package is this plus a suffix.
 * @param {readonly Variant[]} config.variants
 * @param {readonly Binary[]} config.binaries
 * @param {import('./targets.js').Target} on
 * @returns {PlatformPackage[]}
 */
export function packagesFor({ scope, variants, binaries }, on) {
	const packages = [];
	for (const variant of variants) {
		const carried = binariesFor(binaries, variant, on);
		if (carried.length === 0) continue;
		const dirName = `${variant.suffix ? `${variant.suffix.replace(/^-/, '')}-` : ''}${on.name}`;
		packages.push({
			name: `${scope}${variant.suffix}-${on.name}`,
			dirName,
			target: on,
			variant,
			binaries: carried,
			optionalDependency: variant.optional !== true,
			extraDirs: variant.extraDirs ?? [],
		});
	}
	return packages;
}

/** Every package across every target: what the publish job walks, and what the gate checks. @param {any} config @param {readonly import('./targets.js').Target[]} targets */
export const allPackages = (config, targets) => targets.flatMap((on) => packagesFor(config, on));

/** What a package's optionalDependencies should say, at this version. @param {any} config @param {readonly import('./targets.js').Target[]} targets @param {string} version */
export function optionalDependencies(config, targets, version) {
	/** @type {Record<string, string>} */
	const pinned = {};
	for (const pkg of allPackages(config, targets)) {
		// Only the variants that say they belong here. An add-on listed as an optionalDependency is installed
		// on every matching host, which is the cost the split exists to refuse.
		if (pkg.optionalDependency) pinned[pkg.name] = version;
	}
	return pinned;
}

/** The files one package's tarball must carry, for the gate to compare against. @param {PlatformPackage} pkg */
export const expectedFiles = (pkg) => [
	...pkg.binaries.map((binary) => `bin/${binaryFilename(binary.shipsAs, pkg.target)}`),
	'index.js',
	'package.json',
];
