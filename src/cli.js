#!/usr/bin/env node
// @ts-check
// One command per release step, so a workflow calls these rather than reimplementing them in shell.
//
// Every step reads the same config module and the same target list, which is the whole point: the workflow's
// matrix, the staging, the gate and the publish loop all derive the package set from one declaration instead
// of each rediscovering it by globbing a directory. A target that silently failed to build is then a package
// that is silently not published, and nothing notices.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

import { checkFloors } from './floor.js';
import { buildTree } from './layout.js';
import { allPackages, optionalDependencies } from './packages.js';
import { advanceLatest, distTag, publishAll } from './publish.js';
import { confirmPublished } from './published.js';
import { stageAll } from './stage.js';
import { binaryFilename, targets } from './targets.js';
import { verifyAll } from './verify.js';

/** @param {string} message */
const fail = (message) => {
	process.stderr.write(`harper-binary-kit: ${message}\n`);
	process.exit(1);
};

const say = (/** @type {string} */ message) => process.stdout.write(`${message}\n`);

/**
 * The consumer's config and the version it is releasing. Both are read from the repo rather than passed, so a
 * workflow cannot hand one step a different answer from another.
 *
 * @param {string} root
 */
async function load(root) {
	const configPath = resolvePath(root, 'binary-kit.config.js');
	let config;
	try {
		config = (await import(pathToFileURL(configPath).href)).default;
	} catch (error) {
		fail(`could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const version = JSON.parse(readFileSync(resolvePath(root, 'package.json'), 'utf-8')).version;
	return { config, version, targetList: targets(config.targets) };
}

/** @type {Record<string, (root: string, argv: string[]) => Promise<void>>} */
const COMMANDS = {
	/** Stage every platform package from the build trees. `--only <dirName>` stages one. */
	async stage(/** @type {string} */ root, /** @type {string[]} */ argv) {
		const { config, version, targetList } = await load(root);
		const onlyAt = argv.indexOf('--only');
		const only = onlyAt === -1 ? undefined : argv[onlyAt + 1];
		// Deliberately the whole target list even for --only: a package is staged from ITS target's build
		// tree, and filtering the targets first is how `--only probe-linux-x86_64` on a macOS machine staged
		// nothing and reported success.
		const staged = stageAll({ root, config, version, targets: targetList, ...(only ? { only } : {}) });
		for (const name of staged) say(`staged ${name}@${version}`);
	},

	/** Refuse a release whose tarballs are wrong. Reads what npm would pack, never the working tree. */
	async verify(/** @type {string} */ root) {
		const { config, version, targetList } = await load(root);
		const reasons = verifyAll({ root, packages: allPackages(config, targetList), version });
		for (const reason of reasons) say(reason);
		if (reasons.length > 0) fail(`${reasons.length} reason(s) not to publish this release`);
		say(`every package packs at ${version} with the binaries it declares`);
	},

	/** Every binary of one target against the image floor that target declares. */
	async floor(/** @type {string} */ root, /** @type {string[]} */ argv) {
		const { config, targetList } = await load(root);
		const name = argv[0] ?? fail('floor needs a target name');
		const on = targetList.find((candidate) => candidate.name === name) ?? fail(`${name} is not a declared target`);
		const declared = config.floors?.[on.name];
		if (!declared) {
			say(`${on.name} declares no floor; nothing to check`);
			return;
		}
		const files = allPackages(config, [on]).flatMap((pkg) =>
			pkg.binaries.map((binary) => `${buildTree(root, on.name).bin}/${binaryFilename(binary.shipsAs, on)}`)
		);
		const { ok, lines } = checkFloors({ files, floor: declared });
		for (const line of lines) say(line);
		if (!ok) fail(`binaries for ${on.name} need more than the target image provides`);
	},

	/** What optionalDependencies should say at this version, as JSON on stdout. */
	async deps(/** @type {string} */ root) {
		const { config, version, targetList } = await load(root);
		say(JSON.stringify(optionalDependencies(config, targetList, version), null, '\t'));
	},

	/** Every package name in the release, one per line, for a workflow that needs the list. */
	async names(/** @type {string} */ root) {
		const { config, targetList } = await load(root);
		say(config.scope);
		for (const pkg of allPackages(config, targetList)) say(pkg.name);
	},

	/** Publish every package, attempting all of them, then read the registry back. */
	async publish(/** @type {string} */ root) {
		const { config, version, targetList } = await load(root);
		const packages = allPackages(config, targetList);
		const { failed, lines } = publishAll({ root, packages, version });
		for (const line of lines) say(line);

		// Read back rather than trust the exit code: npm has reported a publish it did not make.
		const names = [config.scope, ...packages.map((pkg) => pkg.name)];
		const { ok, missing, lines: readBack } = await confirmPublished({ names, version });
		for (const line of readBack) say(line);
		if (failed.length > 0) fail(`${failed.length} package(s) did not publish: ${failed.map((f) => f.name).join(', ')}`);
		if (!ok) fail(`the registry does not serve ${missing.join(', ')} at ${version}, whatever the publish reported`);
		say(`every package of ${version} is on the registry under ${distTag(version)}`);
	},

	/** Point `latest` at this release, forward only. Fails loudly with the commands if it cannot. */
	async latest(/** @type {string} */ root) {
		const { config, version, targetList } = await load(root);
		const names = [config.scope, ...allPackages(config, targetList).map((pkg) => pkg.name)];
		const { failed, lines, commands } = advanceLatest({ names, version });
		for (const line of lines) say(line);
		if (failed.length === 0) return;
		say('run these with a credential that can write dist-tags:');
		for (const command of commands) say(`  ${command}`);
		fail(`latest was not moved for ${failed.length} package(s); the release itself is published`);
	},
};

const [command, ...argv] = process.argv.slice(2);
const run = COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)];
if (!run) {
	process.stderr.write(`usage: harper-binary-kit <${Object.keys(COMMANDS).join('|')}> [args]\n`);
	process.exit(2);
}
run(process.cwd(), argv).catch((/** @type {unknown} */ error) => {
	fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
