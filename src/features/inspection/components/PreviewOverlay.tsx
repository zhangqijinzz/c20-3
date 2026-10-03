import { Check, X } from 'lucide-react'
import type { LayoutAnalysis, WorkspacePlan } from '../../../shared/models'
import { CanvasStage } from '../../canvas/components/CanvasStage'

interface PreviewOverlayProps {
  plan: WorkspacePlan
  analysis: LayoutAnalysis
  issueCount: number
  onClose: () => void
}

export function PreviewOverlay({ plan, analysis, issueCount, onClose }: PreviewOverlayProps) {
  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <section className="preview-modal">
        <header className="preview-modal-header"><div><span className="eyebrow">LAYOUT PREVIEW</span><h2 id="preview-title">{plan.name}</h2><p>{plan.deskWidthMm} × {plan.deskHeightMm} mm · {plan.items.length} 件设备</p></div><button className="close-preview" aria-label="关闭预览" onClick={onClose} type="button"><X size={18} /></button></header>
        <div className="preview-canvas"><CanvasStage plan={plan} selectedItemId={null} analysis={analysis} onSelect={() => undefined} onMove={() => undefined} /></div>
        <footer className="preview-footer"><span className="preview-check"><Check size={15} /> {issueCount === 0 ? '布局检查通过，可开始搭建' : `还有 ${issueCount} 个位置需要调整`}</span><button className="preview-done" onClick={onClose} type="button">返回编辑</button></footer>
      </section>
    </div>
  )
}
