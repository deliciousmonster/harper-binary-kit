// @ts-check
// Whether the registry took what the publish said it published.
//
// `npm publish` exiting 0 is not the package being there. Measured on 2026-09-11: npm printed
// `Publishing to https://registry.npmjs.org/ with tag next`, exited 0, and for the next twenty-five minutes
// the packument served neither the version nor the tag. Both `npm view --prefer-online` and a direct fetch of
// the packument agreed it was absent; the version endpoint had it the whole time, and a republish was refused
// with "You cannot publish over the previously published versions".
//
// So a read-back asks for the exact version, at `/<name>/<version>`, and never for the package. The packument
// is a cached aggregate and lags its own writes; the version endpoint is the thing that was written. A check
// built on the packument reports a partial release that did not happen, which is how half an hour goes into
// republishing something that was already there.

const REGISTRY = 'https://registry.npmjs.org';

/** The registry path for one version, scope encoded the way the registry wants it. @param {string} name @param {string} version */
export const versionUrl = (name, version, registry = REGISTRY) =>
	`${registry}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;

/**
 * Whether the registry serves this exact version.
 *
 * A 404 is the honest negative. Anything else - a 5xx, a timeout, a body that is not the version asked for -
 * is "could not tell", which a caller must not report as a missing package: telling somebody to republish
 * something already published is the one outcome worse than saying nothing.
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
 * Read every package of a release back, and name the ones that are not there.
 *
 * Run after publishing, and after a wait: the registry is consistent at the version endpoint immediately in
 * every case measured, but a release is worth one retry rather than a false alarm.
 *
 * @param {object} options
 * @param {readonly string[]} options.names @param {string} options.version
 * @param {typeof globalThis.fetch} [options.fetch] @param {string} [options.registry]
 * @returns {Promise<{ ok: boolean, missing: string[], lines: string[] }>}
 */
export async function confirmPublished({ names, version, fetch: get, registry }) {
	const lines = [];
	const missing = [];
	for (const name of names) {
		const { published, detail } = await isPublished(name, version, {
			...(get ? { fetch: get } : {}),
			...(registry ? { registry } : {}),
		});
		lines.push(detail);
		if (!published) missing.push(name);
	}
	return { ok: missing.length === 0, missing, lines };
}
