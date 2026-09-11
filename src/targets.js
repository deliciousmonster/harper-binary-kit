// @ts-check
// Every host a package can publish for, and the three names each one goes by.
//
// A platform package carries one host's binaries and declares `os` and `cpu` so npm installs it on that host
// and skips it everywhere else. Three vocabularies meet here: node's `process.platform`/`process.arch`, npm's
// `os`/`cpu` fields, and whatever label the packages are published under. They disagree on every axis -
// darwin is macos is darwin, x64 is x86_64 is x64 - and a package published under one label while npm filters
// on another installs nowhere and says nothing about it.
//
// A build toolchain's own names (GOOS, a target triple, an SDK) are not here. Those belong to the thing doing
// the building, which is the consumer's, and a target carries whatever extra fields it declares.

/**
 * @typedef {object} Target
 * @property {string} os The label half naming the system, as the packages are published.
 * @property {string} arch The label half naming the architecture.
 * @property {string} name `<os>-<arch>`: the package-name segment and the build directory.
 * @property {string} exe Executable suffix, empty everywhere but Windows.
 * @property {string} npmOs npm's `os` field, matched against process.platform.
 * @property {string} npmCpu npm's `cpu` field, matched against process.arch.
 */

/** How node names a system, against the label the packages use. */
const OS_LABELS = { linux: 'linux', darwin: 'macos', win32: 'windows' };
/** How node names an architecture, against the label the packages use. */
const ARCH_LABELS = { x64: 'x86_64', arm64: 'arm64' };

/** The reverse of OS_LABELS: what npm has to be told, given the label. */
const NPM_OS = Object.fromEntries(Object.entries(OS_LABELS).map(([npm, label]) => [label, npm]));
const NPM_CPU = Object.fromEntries(Object.entries(ARCH_LABELS).map(([npm, label]) => [label, npm]));

/** Windows is the only one, and a binary staged without it is a file npm ships and nothing can run. */
const EXE = { windows: '.exe' };

/**
 * One target from its label. Throws rather than guessing: a label nothing recognises would otherwise publish
 * a package with an `os` field npm never matches, which installs on no host and reports no error.
 *
 * @param {string} name `<os>-<arch>`, e.g. `linux-x86_64`.
 * @returns {Target}
 */
export function target(name) {
	const [os, arch] = name.split('-');
	// Looked up before the check rather than after, so the answers narrow: a lookup that came back undefined
	// is exactly the case the throw is for, and there is nothing left to cast.
	const npmOs = os ? NPM_OS[os] : undefined;
	const npmCpu = arch ? NPM_CPU[arch] : undefined;
	if (!os || !arch || !npmOs || !npmCpu) {
		throw new Error(
			`unknown target "${name}". Known: ${Object.keys(NPM_OS)
				.flatMap((o) => Object.keys(NPM_CPU).map((a) => `${o}-${a}`))
				.join(', ')}`
		);
	}
	return { os, arch, name, exe: EXE[/** @type {keyof typeof EXE} */ (os)] ?? '', npmOs, npmCpu };
}

/** @param {readonly string[]} names @returns {Target[]} */
export const targets = (names) => names.map(target);

/**
 * The label for the host this is running on, or null where there is none.
 *
 * Null rather than a throw: a dev machine the packages are not published for can still run the tests and the
 * staging of another target, and only resolving a binary for THIS host needs an answer.
 *
 * @param {NodeJS.Platform} [platform] @param {string} [arch]
 * @returns {string | null}
 */
export function currentTargetName(platform = process.platform, arch = process.arch) {
	const os = OS_LABELS[/** @type {keyof typeof OS_LABELS} */ (platform)];
	const cpu = ARCH_LABELS[/** @type {keyof typeof ARCH_LABELS} */ (arch)];
	return os && cpu ? `${os}-${cpu}` : null;
}

/** The binary's filename on a target: the name it ships under plus that platform's suffix. @param {string} shipsAs @param {Target} on */
export const binaryFilename = (shipsAs, on) => `${shipsAs}${on.exe}`;
