import { expect, it } from 'vitest'
import { taskSummary } from '../src/client/task-summary.ts'

const item = { title: 'Task', status: 'active' as const, description: '## 任务内容\nTask\n\n## 进展\n- 已观察：`cubemap_slot` 已赋值\n- 待验证：合规格式尚未测试\n- 下一步：检查界面' }

it('reads progress without requiring a separate next action or altering technical identifiers', () => {
  expect(taskSummary(item)).toBe('已观察：cubemap_slot 已赋值')
  expect(taskSummary({ ...item, status: 'todo' })).toBe('下一步：检查界面')
  expect(taskSummary({ ...item, summary: '已赋值，界面尚未显示' })).toBe('已赋值，界面尚未显示')
  expect(taskSummary({ ...item, summary: '' })).toBe('')
})

it('omits absent progress and unsupported backlog next steps', () => {
  expect(taskSummary({ ...item, description: 'Free-form source with no progress section' })).toBe('')
  expect(taskSummary({ ...item, status: 'todo', description: '## 进展\n尚未测试' })).toBe('')
})

it('selects blockers and outcomes without treating code or other sections as progress', () => {
  const description = '## How · 如何推进\n```ts\nnext_action()\n```\n已观察：找到原因\n阻碍：等待权限\n结果：完成验证\n## Why\nWrong section'
  expect(taskSummary({ ...item, description, status: 'blocked' })).toBe('阻碍：等待权限')
  expect(taskSummary({ ...item, description, status: 'done' })).toBe('结果：完成验证')
})
