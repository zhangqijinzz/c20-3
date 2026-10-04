import { describe, expect, it } from 'vitest'
import { LocalWorkspaceRepository } from '../workspaceRepository'
import { SEED_REVISION, type StorageService, type StoredValue } from '../storageService'
import { createInitialDocument } from '../../../shared/models'

function memoryStorage(initial: StoredValue | null = null): StorageService {
  let value = initial
  return {
    read: async () => value,
    write: async (next) => { value = { document: JSON.parse(next) as StoredValue['document'], revision: value?.revision ?? SEED_REVISION } },
    commit: async (next, expectedRevision) => {
      const currentRevision = value?.revision ?? null
      const expected = expectedRevision === SEED_REVISION && (currentRevision === null || currentRevision === SEED_REVISION) ? null : expectedRevision
      if (currentRevision !== expected) {
        return value ? { committed: false as const, document: value.document, revision: currentRevision ?? 'legacy' } : { committed: false as const, document: null, revision: null }
      }
      const revision = `rev-test-${Math.random()}`
      value = { document: JSON.parse(next) as StoredValue['document'], revision }
      return { committed: true as const, document: value.document, revision }
    },
  }
}

describe('local workspace repository', () => {
  it('round trips a document with optimistic revision checking', async () => {
    const repository = new LocalWorkspaceRepository(memoryStorage())
    const document = createInitialDocument()
    const saved = await repository.save(document, SEED_REVISION)
    expect(saved.committed).toBe(true)
    if (!saved.committed) return
    await expect(repository.load()).resolves.toEqual({ document, revision: saved.revision })

    const conflict = await repository.save(document, SEED_REVISION)
    expect(conflict.committed).toBe(false)
  })

  it('falls back when stored JSON is damaged', async () => {
    const damaged: StoredValue = { document: '{broken' as unknown as StoredValue['document'], revision: SEED_REVISION }
    const repository = new LocalWorkspaceRepository({
      read: async () => damaged,
      write: async () => undefined,
      commit: async () => ({ committed: true, document: createInitialDocument(), revision: SEED_REVISION }),
    })
    await expect(repository.load()).resolves.toEqual({ document: null, revision: SEED_REVISION })
  })
})
