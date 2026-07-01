#!/usr/bin/env tsx
/**
 * Secondhand photo-authenticity note (secondhand #2).
 *
 * UOMA shows a "real mobile photos, no ads/retouched" rule on its Goods upload. WebAZ can't actually detect
 * stock/ad images automatically, so the note is worded HONESTLY: guidance ("upload real photos of the actual
 * item") + a truthful consequence ("may be removed if reported" — takedown is real via manifest/admin), and
 * must NOT claim automated rejection we don't perform.
 *
 * Usage: npm run test:secondhand-photo-authenticity
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')

const ZH = '请上传真实实物照，勿用网图/广告图；如经举报核实为虚假图片，商品可能被下架'
const EN = 'Upload real photos of the actual item — no stock/ad images. Listings with fake photos may be removed if reported.'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. the note is rendered on the secondhand form, in the image section (near the sh-imgs input)
const shImgIdx = APP.indexOf('sh-imgs-input')
const noteIdx = APP.indexOf(`t('${ZH}')`)
ok('1a. note is t()-wrapped and rendered in app.js', noteIdx > 0)
ok('1b. note sits in the secondhand image section (adjacent to sh-imgs-input)', shImgIdx > 0 && Math.abs(noteIdx - shImgIdx) < 600)

// 2. bilingual parity
ok('2a. ZH → EN entry present', I18N.includes(`'${ZH}': '${EN}'`))

// 3. HONESTY — the note must NOT claim automated detection/rejection we don't perform (integrity guard).
//    It states guidance + a report-driven takedown (both true), not "auto-rejected / AI-detected".
const overclaim = /自动(拒绝|识别|检测|下架)|系统自动|AI ?(检测|识别)|automatically (reject|detect|remove)|auto-?(reject|detect)/i
ok('3a. note does NOT over-claim automated rejection/detection', !overclaim.test(ZH) && !overclaim.test(EN))
ok('3b. note ties removal to a report ("举报" / "if reported"), not to automation', ZH.includes('举报') && /if reported/i.test(EN))

if (fail > 0) { console.error(`\n❌ secondhand photo-authenticity FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ secondhand photo-authenticity: honest real-photo note rendered on the publish form + bilingual + no automated-rejection over-claim\n  ✅ pass ${pass}`)
