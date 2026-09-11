// @ts-check
// How the binaries split across npm packages. The base variant is an optionalDependency so npm installs one
// host's and skips the rest; an add-on variant is not, so nobody pays for binaries they never run.

import { binaryFilename } from './targets.js';

/**
 * @typedef {object} Binary
 * @property {string} shipsAs The filename it ships under, before the platform's suffix. Also the name a
 *   consumer asks `getBinaryPath` for, which is why it is the one identifier that must not drift.
 * @property {string} [variant] Which variant carries it. Defaults to the base variant.
 * @property {readonly string[]} [onlyOn] Target names that carry it; absent means every target.
 * @property {string} [symbol] A string that must be present in the shipped file. The publish gate reads the
 *   packed tarball for it, which is how a binary built without the thing it exists for is caught.
 * @property {(contents: Buffer, binary: Binary) => string | undefined} [check] One more question about the
 *   packed bytes, answered with a reason to refuse or nothing. A symbol says what a binary was built WITH
 *   and cannot say what it was built WITHOUT, which is the other half of the same defect: the case this
 *   exists for is a Go build tag an exclusion is supposed to have dropped, read back off the artifact
 *   rather than trusted from the flag the build was asked to use. Runs after the symbol test and only when
 *   the file could be read.
 */

/**
 * @typedef {object} Variant
 * @property {string} suffix Appended to the scope before the target label. Empty for the base variant.
 * @property {boolean} [optional] True for a variant installed by name rather than by dependency resolution.
 * @property {string} [carries] Why it is separate, for the error a consumer reads when it is not installed.
 * @property {readonly (string | ExtraDir)[]} [extraDirs] Directories staged beside `bin/`, relative to the
 *   build tree. A plain string is carried on every target this variant publishes on.
 */

/**
 * A directory only some targets carry: one binary can reach the kernel a different way per platform, so two
 * of three ship no objects and a variant-wide directory would refuse to stage them.
 *
 * @typedef {object} ExtraDir
 * @property {string} dir
 * @property {readonly string[]} onlyOn Target names that carry it.
 */

/**
 * @typedef {object} PlatformPackage
 * @property {string} name The npm name.
 * @property {string} dirName Directory under `npm/`. The npm name's last segment, so the two cannot drift.
 * @property {import('./targets.js').Target} target
 * @property {Variant} variant
 * @property {Binary[]} binaries
 * @property {boolean} optionalDependency
 * @property {readonly string[]} extraDirs Already resolved for this target, so every later step reads a
 *   plain list rather than re-deciding what this one carries.
 */

/** Whether a binary ships for a target at all. @param {Binary} binary @param {import('./targets.js').Target} on */
export const shipsOn = (binary, on) => !binary.onlyOn || binary.onlyOn.includes(on.name);

/** The extra directories one variant carries on one target. @param {Variant} variant @param {import('./targets.js').Target} on @returns {string[]} */
export const extraDirsFor = (variant, on) =>
	(variant.extraDirs ?? [])
		.map((entry) => (typeof entry === 'string' ? { dir: entry, onlyOn: undefined } : entry))
		.filter((entry) => !entry.onlyOn || entry.onlyOn.includes(on.name))
		.map((entry) => entry.dir);

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
			extraDirs: extraDirsFor(variant, on),
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
