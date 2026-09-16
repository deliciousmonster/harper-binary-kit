// @ts-check
// Whether the registry took what the publish said. Asked at `/<name>/<version>`, never the packument: that
// aggregate lagged its own writes by 25 minutes on 2026-09-11 and reported a partial release that never was.

const REGISTRY = 'https://registry.npmjs.org';

/** The registry path for one version, scope encoded the way the registry wants it. @param {string} name @param {string} version */
export const versionUrl = (name, version, registry = REGISTRY) =>
	`${registry}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;

/**
 * Whether the registry serves this exact version. A 404 is the honest negative; anything else is "could not
 * tell", because telling somebody to republish what is already there is worse than saying nothing.
 *
 * @param {string} name @param {string} version
 * @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [options]
 * @returns {Promise<{ published: boolean, detail: string }>}
 */
export async function isPublished(name, version, { fetch: get = globalThis.fetch, registry = REGISTRY } = {}) {
	let response;
	try {
		response = await get(versionUrl(name, version, registry), { headers: { accept: 'application/json' } });
	} catch (error) {
		return {
			published: false,
			detail: `could not reach the registry: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (response.status === 404) return { published: false, detail: `the registry has no ${name}@${version}` };
	if (!response.ok)
		return { published: false, detail: `the registry answered ${response.status} for ${name}@${version}` };
	try {
		const body = /** @type {{ name?: string, version?: string }} */ (await response.json());
		if (body.name === name && body.version === version)
			return { published: true, detail: `${name}@${version} is on the registry` };
		return {
			published: false,
			detail: `the registry answered with ${body.name}@${body.version} for ${name}@${version}`,
		};
	} catch (error) {
		return {
			published: false,
			detail: `the registry's answer for ${name}@${version} did not parse: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Read every package of a release back and name the ones absent, retrying the absent ones until they appear
 * or the deadline passes. On 2026-09-14 a release read back one second after publishing reported 5 of 8
 * missing; all 8 were there, and the last took 13 minutes to serve. Without the wait the step fails a release
 * that worked, and a retry cannot mask a real failure because a package that never publishes never appears.
 *
 * The ceiling is 30 minutes because 7.82.1-next.15 exceeded a 20-minute one: eight packages served inside a
 * second and the ninth took longer than the whole budget. Waiting is the only thing that separates a slow
 * read from an absent package, so the ceiling buys a margin and `readBackVerdict` decides what running out
 * of it means.
 *
 * @param {object} options
 * @param {readonly string[]} options.names @param {string} options.version
 * @param {typeof globalThis.fetch} [options.fetch] @param {string} [options.registry]
 * @param {number} [options.timeoutMs] How long to keep asking. @param {number} [options.intervalMs]
 * @param {(ms: number) => Promise<void>} [options.wait] @param {() => number} [options.now]
 * @returns {Promise<{ ok: boolean, missing: string[], lines: string[] }>}
 */
export async function confirmPublished({
	names,
	version,
	fetch: get,
	registry,
	timeoutMs = 30 * 60_000,
	intervalMs = 15_000,
	wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = Date.now,
}) {
	const options = { ...(get ? { fetch: get } : {}), ...(registry ? { registry } : {}) };
	const deadline = now() + timeoutMs;
	const lines = [];
	let pending = [...names];
	let last = new Map();

	for (;;) {
		const stillMissing = [];
		for (const name of pending) {
			const { published, detail } = await isPublished(name, version, options);
			last.set(name, detail);
			if (!published) stillMissing.push(name);
		}
		pending = stillMissing;
		if (pending.length === 0 || now() >= deadline) break;
		lines.push(`waiting for the registry to serve ${pending.length} package(s): ${pending.join(', ')}`);
		await wait(intervalMs);
	}

	for (const name of names) lines.push(String(last.get(name)));
	return { ok: pending.length === 0, missing: pending, lines };
}

/**
 * What a read-back says, confirmed or not. An unconfirmed one is deliberately not a failure: every
 * `npm publish` succeeded before this point or the caller stopped there, so a package still absent at the
 * deadline is the registry not serving a write it accepted. Stopping here skips the tag write, and `latest`
 * then stays on the previous release while every package of the new one sits on the registry. That is what
 * happened to 7.82.1-next.15, and it cost a hand-run `dist-tag add` across nine packages.
 *
 * The tag write is the better gate. A GET is answered by a CDN edge that can lag its own origin; `npm
 * dist-tag add` reads the authoritative store and errors on a version that is genuinely not there. So the
 * line has to leave an operator able to act on it, which is what the test holds it to.
 *
 * @param {readonly string[]} missing @param {string} version
 * @returns {string}
 */
export function readBackLine(missing, version) {
	if (missing.length === 0) return `every package of ${version} is on the registry`;
	return (
		`the registry has not served ${missing.join(', ')} at ${version} yet, though npm accepted every ` +
		`publish. Moving latest is the next step and it reads the authoritative store, so it fails if any of ` +
		`these is truly absent.`
	);
}
