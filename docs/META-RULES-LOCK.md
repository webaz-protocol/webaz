# Meta-Rules Lock — v1.0 / 元规则 v1.0 锁

> **Purpose**: Declares the v1.0 lock of WebAZ's 10 meta-rules, including the SHA256 hash of the canonical machine-readable form. Any change to the canonical form is CI-detected and requires CHARTER §4 I-1 amendment procedure.
> **目的**:声明 WebAZ 十条元规则 v1.0 锁定状态,含 canonical 机读版的 SHA256 哈希。任何变更被 CI 检测,必须走 CHARTER §4 I-1 修宪流程。

---

## §1 Lock declaration / 锁定声明

| Field | Value |
|---|---|
| Version | **v1.0** |
| Locked at | **2026-06-03** |
| Canonical file | `docs/meta-rules.yaml` |
| Canonical SHA256 | `cb6935712a2260aa75148fcaf8494e7de1674ec1a35100d99c047d1f53db2634` |
| Prose expansion | `docs/META-RULES-FULL.md`(可演化,非 lock 范围 / evolvable, not in lock scope)|
| Amendment authority | `CHARTER.md §4 I-1` + `§4 I-4`(constitutional amendment)|
| Enforcement | `scripts/meta-rules-invariant-check.ts`(`npm run meta-rules:check`)+ CI job |

The SHA256 above must equal the SHA256 of `docs/meta-rules.yaml` as committed. If they diverge, the meta-rules-invariants CI check fails. This forces any change to either side to update the other(per amendment procedure).

---

## §2 What the lock covers / 锁定范围

**Locked**(in `meta-rules.yaml`):
- The 10 rule **one-liners**(both zh and en)
- Rule **layer assignment**(faith / red_lines / operations / identity)
- Rule **IDs**(1-10, cannot be renumbered)
- Anchor links to `META-RULES-FULL.md` sections

**NOT locked**(can evolve through normal RFC):
- Prose expansion in `META-RULES-FULL.md`(5-field detail per rule:核心 / 反例 / 适用 / AI hint / 开发协作场景)
- Cross-rule conflict resolution decision trees
- Example case studies
- Inline references / footnotes / formatting

Rationale: the 10 one-liners are the protocol's **constitutional core** and must not silently drift. The expansion is **documentation** and should remain free to clarify without amendment overhead.

---

## §3 Amendment procedure / 修订流程

Any change to `meta-rules.yaml`(or attempt to delete any rule)triggers `CHARTER §4 I-1` amendment procedure:

1. **RFC issue** opened on GitHub describing proposed change + rationale
2. **60-day public notice** period(GitHub Issue stays open + linked from project README + announced via public channels)
3. **Supermajority multisig**:
   - Phase A solo:user 1-of-1(because solo, see CHARTER §4 I-4 phase A explanation)
   - Phase B+:`≥ constitutional_supermajority_ratio`(default 0.667 = 2/3)of maintainers sign,user as one signer(no personal veto)
4. **Hash bump**:if rule **one-liner / layer / id** is the modification target,the canonical SHA256 in this file MUST be updated in the same merge commit
5. **Version bump**:
   - **Refinement**(e.g.,clarify zh translation): v1.0 → v1.1
   - **Substantive change**(meaning shift): v1.0 → v2.0
   - **Adding a new rule**: forbidden by spec(10 is locked count)
   - **Removing a rule**: forbidden by spec(only refinement permitted)

The amendment must include this LOCK.md updates in the same PR as the yaml update.

---

## §4 Anti-circumvention design / 防绕过设计

### 4.1 Direct yaml edit
If someone edits `docs/meta-rules.yaml` directly without updating the hash in this file → `meta-rules:check` script computes the new hash and compares to the expected hash here → mismatch → CI fails → PR cannot merge to main(branch protection enforces "all CI green required").

### 4.2 Direct LOCK.md hash edit
If someone updates the hash in this file without changing yaml → same CI script detects mismatch → CI fails. Forces the editor to actually update yaml,which forces them through amendment procedure.

### 4.3 Bypass attempts
Attempting to skip CI(`-c` flag,direct main push,merge from UI without checks)is prevented by branch protection on `main`. Phase A solo maintainer technically has admin override,but using it leaves a clear audit trail in GitHub admin log + must be retro-justified in public RCA.

### 4.4 Git tag claim
A signed git tag(e.g., `meta-rules-v1.0`)can be created post-merge as additional anchoring,but is **not required** by CI(it would require maintainer GPG keys which phase A may not have set up). The combined yaml + LOCK.md mechanism is the primary enforcement.

---

## §5 Version history / 版本历史

| Version | Date | Notes | SHA256 |
|---|---|---|---|
| v1.0 | 2026-06-03 | Initial lock at W3.5 end / task #1086 | `cb6935712a2260aa75148fcaf8494e7de1674ec1a35100d99c047d1f53db2634` |

Future amendments append rows here. Each row is the canonical record of that version's hash.

---

## §6 References / 参考

- `docs/meta-rules.yaml` — canonical locked content
- `docs/META-RULES-FULL.md` — prose expansion(evolvable)
- `docs/CHARTER.md` §2 — one-liners(must match yaml)
- `docs/CHARTER.md` §4 I-1 — meta-rules inviolable invariant
- `docs/CHARTER.md` §4 I-4 — constitutional amendment protection
- `docs/CHARTER.md` §6 — amendment procedure
- `scripts/meta-rules-invariant-check.ts` — CI script
- `.github/workflows/ci.yml` — CI job `meta-rules invariants`
