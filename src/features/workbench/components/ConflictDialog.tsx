import { TriangleAlert } from 'lucide-react'
import type { ConflictState } from '../workspaceSynchronizer'

interface ConflictDialogProps {
  conflict: ConflictState
  isLocalSide: boolean
  onResolve: (choice: 'local' | 'remote') => void
}

export function ConflictDialog({ conflict, isLocalSide, onResolve }: ConflictDialogProps) {
  const ownCount = (isLocalSide ? conflict.localChangedPlanIds : conflict.remoteChangedPlanIds).length
  const otherCount = (isLocalSide ? conflict.remoteChangedPlanIds : conflict.localChangedPlanIds).length
  return (
    <div className="conflict-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title">
      <section className="conflict-dialog">
        <div className="conflict-icon"><TriangleAlert size={24} /></div>
        <span className="eyebrow">SYNC CONFLICT</span>
        <h2 id="conflict-title">两个窗口同时修改了同一方案</h2>
        <p>继续保存会覆盖另一边的改动。请选择保留当前窗口的 {ownCount} 项修改，还是采用另一个窗口的 {otherCount} 项修改。</p>
        <div className="conflict-actions">
          <button onClick={() => onResolve('remote')} type="button">采用另一个窗口</button>
          <button className="conflict-primary" onClick={() => onResolve('local')} type="button">保留本窗口</button>
        </div>
        <small>未选择前，两个窗口都会保持只读，不会发生无声覆盖。</small>
      </section>
    </div>
  )
}
