import { defineConfig } from 'vitest/config'
import ts from 'typescript'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [{
    name: 'personal-standard-decorators', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
      const result = ts.transpileModule(code, { fileName: file, compilerOptions: {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX, sourceMap: true,
      } })
      return { code: result.outputText, map: result.sourceMapText }
    },
  }],
  test: {
    testTimeout: 30000, hookTimeout: 30000,
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-/, /@deepseek-ai\/dsh-storage-json/] } },
    projects: [
      { extends: true, test: { name: 'host', include: ['packages/host/tests/**/*.spec.ts', 'scripts/**/*.spec.ts'] } },
      { extends: true, test: { name: 'client', environment: 'jsdom', include: ['packages/client/tests/**/*.spec.ts', 'packages/client/tests/**/*.spec.tsx'] } },
    ],
  },
})
