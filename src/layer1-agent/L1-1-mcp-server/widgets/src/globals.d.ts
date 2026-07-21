/**
 * Ambient declarations for the widget script-concatenation runtime (A1 widget sourcing).
 *
 * At runtime every widget is ONE <script> built by buildWidgetHtml() as:
 *   theme-boot + compat-core (+ compat-link) (+ bridge-standard) + <body> + <boot>
 * All parts share a single function scope, so body/boot files legitimately reference
 * functions defined in compat/bridge parts as "globals". These ambients give tsc that
 * shared-scope view; the generator (scripts/gen-widget-js.ts) strips the `export `
 * markers so the emitted runtime strings stay byte-identical to the pre-A1 literals.
 */
declare function canFollowUp(oai: unknown): boolean
declare function sendFollowUpCompat(oai: unknown, text: string): boolean
declare function onceGuard(fn: (...args: unknown[]) => void, ms?: number): (...args: unknown[]) => void
declare function etaDisplay(v: unknown, region?: unknown): string
declare function webazConsume(r: unknown): unknown
declare function callWebazTool(oai: unknown, name: string, args: unknown): Promise<{ ok: boolean; structuredContent?: Record<string, unknown>; error?: string | null; timeout?: boolean; sourceBridge?: string }>
declare function webazExecCopy(text: unknown): boolean
declare function webazSelect(el: unknown): boolean
declare function webazLocale(): string
declare function L(zh: string, en: string): string
declare function webazCopy(text: unknown, btn?: unknown, selEl?: unknown): void
declare function safeWebazHref(h: unknown): string | null
declare function openWebaz(oai: unknown, href: unknown): boolean
declare function makeStandardBridge(onToolResult: (r: { structuredContent?: Record<string, unknown> }) => void): {
  connect: (timeoutMs: number) => Promise<unknown>
  callTool: (n: string, a?: unknown) => Promise<unknown>
  openLink: (url: string) => Promise<unknown>
  sendMessage: (text: string) => Promise<unknown>
}
declare var __inlineConsuming: number
declare function renderBody(oai: unknown, out: unknown): void
interface Window { openai?: { theme?: string; toolOutput?: unknown } & Record<string, unknown> }
