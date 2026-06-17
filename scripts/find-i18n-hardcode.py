#!/usr/bin/env python3
"""精确扫描 user-facing 中文 hardcode（漏 t() 包装的）

排除假阳性（合法代码）：
- HTML 注释 <!-- ... -->
- JS 单行注释 // ...
- JS 多行注释 /** */ /* */
- regex 字符类 [一-龥] / [\\u4e00-\\u9fa5]
- regex 字面量 .match() / .replace() / RegExp()
- lang toggle: _lang === 'en' ? '中文' : 'EN'（反向显示逻辑）
- console.* / logAdminAction / logError

用法：
  scripts/find-i18n-hardcode.py                # 统计 + 高优先级前 10
  scripts/find-i18n-hardcode.py --verbose      # 全部候选行
  scripts/find-i18n-hardcode.py --strict       # 仅 label/title/placeholder
  scripts/find-i18n-hardcode.py --ci           # CI 模式 — 高优 > 0 退出 1
  scripts/find-i18n-hardcode.py --file path    # 指定文件（默认 app.js）

退出码：0 = OK / 1 = CI 模式下发现高优先级 hardcode
"""
import re
import sys
import argparse

CHINESE_CHAR = re.compile(r'[一-龥]')

# 假阳性过滤器（按行内容判断）
FALSE_POSITIVE_PATTERNS = [
    re.compile(r'^\s*<!--'),                     # HTML 注释开头
    re.compile(r'^\s*//'),                       # JS 单行注释
    re.compile(r'^\s*\*'),                       # JS 多行注释中间行
    re.compile(r'^\s*/\*'),                      # JS 多行注释开头
    re.compile(r'<!--.*-->'),                    # 同行 HTML 注释
    re.compile(r'//[^\'\"]*[一-龥]'),    # 行内中文是 // 之后
    re.compile(r'\[\\u4e00-\\u9fa5\]|\[一-龥\]'),  # regex 字符类
    re.compile(r'\.match\(|\.replace\(|RegExp\('),
    re.compile(r"_lang === 'en'|_lang === \"en\""),
    re.compile(r'console\.(error|warn|log|info)'),
    re.compile(r'logAdminAction\(|logError\('),
    re.compile(r'throw new Error\('),            # 后端 throw 不需要 i18n
]

# 高优先级模式（必修）— user-facing UI
STRICT_PATTERNS = [
    re.compile(r"label:\s*['\"][^'\"]*[一-龥]"),
    re.compile(r"title=\"[^\"]*[一-龥]"),
    re.compile(r"placeholder=\"[^\"]*[一-龥]"),
    re.compile(r"placeholder:\s*['\"][^'\"]*[一-龥]"),
    re.compile(r"innerHTML[^=]*=\s*['\"`][^'\"]*[一-龥]"),
]


def scan(file_path: str):
    with open(file_path, encoding='utf-8') as f:
        lines = f.readlines()

    raw, no_t, filtered, strict = [], [], [], []

    for i, line in enumerate(lines, 1):
        if not CHINESE_CHAR.search(line):
            continue
        raw.append((i, line.rstrip()))
        # 排除已 t() 包装
        if "t('" in line:
            continue
        no_t.append((i, line.rstrip()))
        # 排除假阳性
        if any(p.search(line) for p in FALSE_POSITIVE_PATTERNS):
            continue
        filtered.append((i, line.rstrip()))
        # 高优先级
        if any(p.search(line) for p in STRICT_PATTERNS):
            strict.append((i, line.rstrip()))

    return raw, no_t, filtered, strict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default='src/pwa/public/app.js')
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--strict', action='store_true')
    ap.add_argument('--ci', action='store_true', help='发现高优时退出 1')
    args = ap.parse_args()

    raw, no_t, filtered, strict = scan(args.file)

    print(f"=== i18n hardcode scan: {args.file} ===")
    print(f"总含中文行：    {len(raw):>4}")
    print(f"已 t() 包装：    {len(raw) - len(no_t):>4}")
    print(f"未 t() 候选：    {len(no_t):>4}")
    print(f"排除假阳性后：  {len(filtered):>4}  ← 需关注")
    print(f"高优先级 UI：  {len(strict):>4}   ← 必修")
    print()

    if args.verbose:
        print(f"=== 全部 {len(filtered)} 候选行 ===")
        for line_no, line in filtered:
            print(f"  L{line_no}: {line[:120]}")
    elif args.strict:
        print(f"=== 高优先级 {len(strict)} 行（label/title/placeholder）===")
        for line_no, line in strict[:50]:
            print(f"  L{line_no}: {line[:120]}")
        if len(strict) > 50:
            print(f"  ... 还有 {len(strict) - 50} 行（用 --verbose 看全部）")
    else:
        print(f"=== 高优先级前 10 预览 ===")
        for line_no, line in strict[:10]:
            print(f"  L{line_no}: {line[:120]}")
        print()
        print(f"--verbose 看全部 {len(filtered)} | --strict 看 {len(strict)} 个高优 | --ci 用于 CI gate")

    # CI 模式
    if args.ci and len(strict) > 0:
        print(f"\n❌ CI: 发现 {len(strict)} 个高优先级 hardcode，请用 t() 包装")
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()
