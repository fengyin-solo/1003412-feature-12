// 自检前置：用项目自带 tsc 把检查站业务源码（含数据层）编译到 .verify-dist，
// 再把 @ 别名与无扩展名相对导入改写成 Node ESM 能直接运行的路径。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, '.verify-dist')
mkdirSync(outDir, { recursive: true })

// @ 路径别名只在打包器（vite）里生效，tsc 命令行会报两条 TS2307，但仍会照常产出 JS，
// 这里只容忍这两条预期内的别名解析错误，其余错误一律抛出。
try {
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      resolve(root, 'src/api/checkpoint-service.ts'),
      resolve(root, 'src/data/local-store.ts'),
      resolve(root, 'src/data/seed.ts'),
      resolve(root, 'src/data/types.ts'),
      '--target',
      'ES2020',
      '--module',
      'ES2020',
      '--moduleResolution',
      'node',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--lib',
      'ES2020,DOM',
      '--outDir',
      outDir,
      '--rootDir',
      resolve(root, 'src'),
    ],
    { cwd: root, stdio: 'pipe', encoding: 'utf8' },
  )
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  const unexpected = output
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.includes("error TS2307: Cannot find module '@/"))
  if (unexpected.length > 0) {
    process.stderr.write(output)
    throw error
  }
}

const patch = (relativePath, rules) => {
  const file = resolve(outDir, relativePath)
  let content = readFileSync(file, 'utf8')
  for (const [from, to] of rules) {
    content = content.split(from).join(to)
  }
  writeFileSync(file, content)
}

patch('api/checkpoint-service.js', [
  ["'@/data/local-store'", "'../data/local-store.js'"],
  ["'@/data/types'", "'../data/types.js'"],
])
patch('data/local-store.js', [["'./seed'", "'./seed.js'"], ["'./types'", "'./types.js'"]])
patch('data/seed.js', [["'./types'", "'./types.js'"]])

console.log('自检产物已就绪：.verify-dist')
