#!/usr/bin/env tsx
/**
 * 轮询节流治理(第一刀,UI-only)—— 静态接线锚。
 *   信令按需化(无活动 3s→60s,活动/主动 offer 恢复快节奏)+ 可见性暂停(信令/心跳/聊天)+ 回前台补拉。
 *   fail-open:governor 未加载时 app.js 维持旧 3s 行为。
 * Usage: npm run test:poll-governor
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const GOV = readFileSync('src/pwa/public/app-poll-governor.js', 'utf8')
const CHAT = readFileSync('src/pwa/public/app-chat-poll.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')

// ── ① app.js 接线(全部净零行折入)──
ok('1. signaling interval routed through pollGate, FAIL-OPEN when governor absent',
  /_signalingTimer = setInterval\(\(\) => \{ if \(!window\.pollGate \|\| window\.pollGate\('signaling'\)\) p2pSignalingTick\(\) \}, 3_000\)/.test(APP))
ok('2. _p2pSigTick exposed for the on-visible catch-up fetch', /window\._p2pSigTick = p2pSignalingTick/.test(APP))
ok('3. heartbeat paused while hidden', /_heartbeatTimer = setInterval\(\(\) => \{ if \(!document\.hidden\) p2pHeartbeatTick\(\) \}, 60_000\)/.test(APP))
ok('4. incoming signals feed pollActivity (restores fast cadence)',
  /GET\('\/signaling\/poll'\); if \(window\.pollActivity\) pollActivity\('signaling', \(data\.signals \|\| \[\]\)\.length\)/.test(APP))
ok('5. initiating an offer boosts cadence (handshake stays at 3s)',
  /type: 'offer', data: offer \}\); if \(window\.pollBoost\) pollBoost\(\)/.test(APP))

// ── ② governor 语义 ──
ok('6. hidden → gate closed (all governed polls pause)', /if \(document\.hidden\) return false/.test(GOV))
ok('7. idle cadence = every 20th 3s tick (60s)', /IDLE_EVERY = 20/.test(GOV) && /tick % IDLE_EVERY === 0/.test(GOV))
ok('8. activity only boosts on n>0 (empty polls do not keep fast mode alive)', /pollActivity = \(kind, n\) => \{ if \(n > 0\)/.test(GOV))
ok('9. back-to-visible: boost + catch-up signaling + catch-up chat',
  /visibilitychange/.test(GOV) && /pollBoost\(30_000\)/.test(GOV) && /_p2pSigTick\(\)/.test(GOV) && /_chatPollNow\(\)/.test(GOV))

// ── ③ 聊天轮询 ──
ok('10. chat tick pauses while hidden (timer kept, resumes on visible)', /if \(document\.hidden\) return; let rr = null/.test(CHAT))
ok('11. chat exposes _chatPollNow and stop() clears it (no stale catch-up into a dead conversation)',
  /window\._chatPollNow = tickFn/.test(CHAT) && /window\._chatPollTimer = null; window\._chatPollNow = null/.test(CHAT))

// ── ④ 装载 ──
ok('12. governor script loaded (after chat-poll, before app.js)',
  HTML.indexOf('app-poll-governor.js') > HTML.indexOf('app-chat-poll.js') && HTML.indexOf('app-poll-governor.js') < HTML.indexOf('"/app.js"') && HTML.indexOf('app-poll-governor.js') > 0)

if (fail > 0) { console.error(`\n❌ poll-governor FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ poll governor (knife 1): adaptive signaling 3s↔60s (fail-open) + visibility pause (signaling/heartbeat/chat) + on-visible catch-up\n  ✅ pass ${pass}`)
