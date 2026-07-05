/**
 * Single source of truth for WebAZ version axes — RFC-011 §④ (version hygiene).
 *
 * TWO DISTINCT AXES. Do not conflate them — conflating is exactly the dirt this file kills
 * (the old hardcoded MCP `SERVER_VERSION='0.1.8'` + Server handshake `version:'0.1.0'` drifted
 *  away from the real package version 0.1.19; this makes that structurally impossible).
 *
 * 1. SOFTWARE_VERSION — npm / release semver of THIS codebase (MCP client+server + PWA).
 *    Read from package.json at runtime so it can NEVER drift. Bumps on every release.
 *    Resolves from both dev (tsx src/version.ts → ../package.json) and prod/published
 *    (node dist/version.js → ../package.json), since package.json sits at the package root
 *    and is always included in the npm tarball.
 *
 * 2. CONTRACT_VERSION — the agent-native INTEGRATION CONTRACT version (manifest `schema_version`).
 *    A deliberate integer that integrators' agents key off. Bump ONLY on a *breaking* change to
 *    the data contract they read (entity shape / boundary / verifiable-field semantics).
 *    INDEPENDENT of software releases — a patch/feature release does NOT bump it; a breaking
 *    contract change DOES, even within the same software version. Governs RFC-011's contract.
 *
 * Both are surfaced to integrators in /.well-known/webaz-protocol.json so an agent can read
 * "contract vN running software x.y.z" and decide compatibility.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

/** npm/release semver — single source = package.json. Never hardcode a copy of this. */
export const SOFTWARE_VERSION: string = pkg.version

/** Integration-contract version. Bump on ANY integrator-observable contract-surface change
 *  (capability matrix §② / entity dictionary §① / the §④ integration-contract entry document itself);
 *  the CONTRACT_CHANGES `kind` classifies whether it is breaking. Additive changes (kind:'added') are
 *  safe for agents to ignore. Guarded by tests/test-contract-fingerprint.ts + docs/CONTRACT-LOCK.json.
 *  NB: the fingerprint hashes only §②/§① content; a change to the §④ entry document (e.g. agent_quickstart)
 *  is integrator-observable but NOT fingerprinted, so it must be registered here by hand. */
export const CONTRACT_VERSION = 20
