import { describe, expect, it } from 'vitest'
import { NULL_REVISION, toStoredRecord } from '../storageService'
import { createInitialDocument } from '../../../shared/models'

describe('toStoredRecord 存储记录解析', () => {
  it('解析版本化记录', () => {
    const document = createInitialDocument()
    const record = toStoredRecord(JSON.stringify({ revision: 7, document, committer: 'win-1' }))
    expect(record?.revision).toBe(7)
    expect(record?.committer).toBe('win-1')
    expect(record?.document).toEqual(document)
  })

  it('把旧版本的裸文档按 revision 0 迁移', () => {
    const document = createInitialDocument()
    const record = toStoredRecord(JSON.stringify(document))
    expect(record?.revision).toBe(NULL_REVISION)
    expect(record?.document).toEqual(document)
    expect(record?.committer).toBe('legacy')
  })

  it('拒绝损坏或形状不符的数据', () => {
    expect(toStoredRecord('{broken')).toBeNull()
    expect(toStoredRecord(null)).toBeNull()
    expect(toStoredRecord({ revision: 3, document: { version: 9, plans: [] } })).toBeNull()
  })
})
