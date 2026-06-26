/**
 * Compatibility re-export.
 *
 * The pure idempotent schema helpers were relocated to a neutral top-level
 * module (src/runtime/webaz-schema-helpers.ts) so the PWA boot path and the MCP
 * runtime schema composition root can share ONE source. This file keeps the
 * historical `./server-schema.js` import path working for src/pwa/server.ts.
 */
export * from '../runtime/webaz-schema-helpers.js'
