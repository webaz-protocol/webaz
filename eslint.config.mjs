// A1 widget sourcing — ESLint scoped to the widget runtime sources ONLY (repo has no repo-wide lint).
// Run: npm run lint:widgets
// The widget sources are byte-frozen ES5-style runtime scripts (see widgets/src/globals.d.ts header):
// rules that would force rewrites (no-var, prefer-const, unused-vars for cross-file concat symbols)
// are disabled; what we want from lint here is the bug-catching core (syntax, suspicious semantics).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    files: ['src/layer1-agent/L1-1-mcp-server/widgets/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],          // catch(e){} 是 widget 的显式降级手法
      '@typescript-eslint/no-unused-vars': 'off',                // renderBody 等符号在拼接期被相邻片段消费
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',                // 可剥离 @ts-nocheck 标记是 A1 冻结契约的一部分
      'no-var': 'off',
      'prefer-const': 'off',
      'no-useless-escape': 'off',                                // 字节冻结:正则转义原样保留
      'prefer-spread': 'off',                                    // onceGuard 的 fn.apply(null,arguments) 是故意 ES5(宿主 iframe 兼容面)
      'prefer-rest-params': 'off',
      'no-useless-assignment': 'off',                            // quote-approval-body 3 处既有写法;A2 内容合法变更时一并清理
    },
  },
)
