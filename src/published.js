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
 * Read every package of a release back and name the ones absent. Run after a wait: the version endpoint was
 * immediately consistent in every case measured, but a release is worth one retry over a false alarm.
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
