/**
 * 把插件装进 desktop profile：
 *   1) dependencies 加 link:（保持 pnpm 语义一致）
 *   2) dsh.profile.bundles 追加插件名（决定是否被加载）
 *   3) node_modules 建 junction（Windows 无需管理员）
 */
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件源码目录（脚本的上一级），clone 到哪里都能用。 */
const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
/** 目标 profile：默认 ~/.dsh/profiles/desktop，可用 DSH_PROFILE_DIR 覆盖。 */
const PROFILE = process.env.DSH_PROFILE_DIR?.trim() || join(homedir(), '.dsh', 'profiles', 'desktop')
const NAME = 'dsh-opencode-go-pool'

const pkgPath = join(PROFILE, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

pkg.dependencies[NAME] = `link:${SRC}`
// 保持依赖按字母序（与现有风格一致）
pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)))

const bundles = pkg.dsh.profile.bundles
if (!bundles.includes(NAME)) bundles.push(NAME)

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log('package.json 已更新')

const linkPath = join(PROFILE, 'node_modules', NAME)
if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
  rmSync(linkPath, { recursive: true, force: true })
}
symlinkSync(SRC, linkPath, 'junction')
console.log('junction 已建立:', linkPath)
