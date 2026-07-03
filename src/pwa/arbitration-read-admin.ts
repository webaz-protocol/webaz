/**
 * 争议详情【只读】admin 授权谓词 —— 与后台列表 /api/admin/disputes 的 requireArbitrationAdmin
 * (= requireAdminPermission(req,res,'arbitration'))【等价】的纯布尔判定(不发响应,可在 guard 里与其他条件组合)。
 *
 * 单一真相源:server.ts 注册 disputes-read、以及 test-disputes-read-auth 都用它 → 后台列表与详情页授权一致,
 * 不会出现"能进列表却进不了详情"(错挡)或"没 arbitration 权限却能直读详情"(错放)。
 *
 * 规则(镜像 server.ts 的 requireAdmin + hasAdminPermission,见 server.ts:3739/3765):
 *   1. 必须是 admin:user.role === 'admin' 或 roles 数组含 'admin'(grant-role 只把 admin 加进 roles,不改主 role)。
 *   2. 且具 arbitration 权限:root admin(admin_type 缺省视为 'root')隐式拥有 all;区域 admin 看 admin_permissions
 *      是否含 'all' 或 'arbitration'。
 * 注意:isRoot 用 admin_type ?? 'root' —— 非 admin 用户 admin_type 为 NULL 会被当 root,所以【必须】先过第 1 步 admin 门,
 *   否则普通 buyer 会被误判为 root(与 server.ts 先 requireAdmin 再 hasAdminPermission 的顺序一致)。
 */
export function isArbitrationReadAdmin(user: Record<string, unknown> | null | undefined): boolean {
  if (!user) return false
  const roles = (() => { try { return JSON.parse((user.roles as string) || '[]') as string[] } catch { return [] } })()
  const isAdmin = user.role === 'admin' || (Array.isArray(roles) && roles.includes('admin'))
  if (!isAdmin) return false
  const isRoot = ((user.admin_type as string) || 'root') === 'root'
  if (isRoot) return true
  const perms = (() => { try { return JSON.parse((user.admin_permissions as string) || '[]') as string[] } catch { return [] } })()
  return Array.isArray(perms) && (perms.includes('all') || perms.includes('arbitration'))
}
