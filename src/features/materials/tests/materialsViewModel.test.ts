import { describe, expect, it } from 'vitest'
import { createMaterialDraft } from '../materialsViewModel'

describe('materials module', () => {
  it('creates a device draft with catalog dimensions and feedback', () => {
    const draft = createMaterialDraft('lamp', 2)
    expect(draft.item.type).toBe('lamp')
    expect(draft.item.widthMm).toBe(180)
    expect(draft.feedback).toBe('桌面灯已添加')
  })
})
