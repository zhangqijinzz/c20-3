import { describe, expect, it } from 'vitest'
import { createItem, createPlan } from '../../../shared/models'
import { inspectPlan } from '../inspectionViewModel'

describe('inspection module', () => {
  it('turns layout analysis into a user-facing issue summary', () => {
    const plan = createPlan('检查', false)
    const first = { ...createItem('monitor'), x: 0, y: 0 }
    const second = { ...createItem('keyboard'), x: 100, y: 80 }
    const result = inspectPlan({ ...plan, items: [first, second] })
    expect(result.issueCount).toBe(2)
    expect(result.issueIds).toEqual(expect.arrayContaining([first.id, second.id]))
  })
})
