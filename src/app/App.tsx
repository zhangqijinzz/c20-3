import { Check, Cloud, CloudOff, FileCheck2, Lock, PanelTop, RefreshCw, TriangleAlert } from 'lucide-react'
import { DEVICE_DEFINITIONS } from '../shared/models'
import { CanvasStage } from '../features/canvas/components/CanvasStage'
import { DevicePalette } from '../features/materials/components/DevicePalette'
import { InspectorPanel } from '../features/inspection/components/InspectorPanel'
import { PreviewOverlay } from '../features/inspection/components/PreviewOverlay'
import { PlanSidebar } from '../features/workbench/components/PlanSidebar'
import { ConflictBanner } from '../features/workbench/components/ConflictBanner'
import { useWorkspaceViewModel } from '../features/workbench/workbenchViewModel'

export function App() {
  const viewModel = useWorkspaceViewModel()
  const { document, activePlan, selectedItem, analysis, issueIds, issueCount } = viewModel
  const isReadOnly = viewModel.status === 'readonly'

  if (!document || !activePlan) {
    return <main className="loading-screen"><span className="loading-orb" /><p>正在打开 FocusDesk…</p></main>
  }

  const saveStateLabel = isReadOnly
    ? '只读 · 等待冲突处理'
    : viewModel.status === 'saving'
      ? '保存中…'
      : viewModel.status === 'error'
        ? '保存异常'
        : '已同步到本机各窗口'

  return (
    <main className={`app-shell ${isReadOnly ? 'is-readonly' : ''}`}>
      <PlanSidebar plans={document.plans} activePlanId={document.activePlanId} readOnly={isReadOnly} onSelect={viewModel.selectPlan} onCreate={viewModel.createNewPlan} onDuplicate={viewModel.duplicatePlan} onDelete={viewModel.deleteCurrentPlan} />
      <section className="app-main">
        <header className="topbar">
          <div className="breadcrumb"><span>工作台</span><span>/</span><strong>{activePlan.name}</strong>{isReadOnly && <span className="readonly-crumb"><Lock size={11} /> 只读</span>}</div>
          <div className="topbar-actions">
            <span className={`save-state ${viewModel.status === 'error' ? 'save-error' : ''} ${isReadOnly ? 'save-readonly' : ''}`}>
              {isReadOnly ? <Lock size={15} /> : !viewModel.channelHealthy ? <CloudOff size={15} /> : viewModel.status === 'saving' ? <RefreshCw size={15} className="spin-icon" /> : <Cloud size={15} />}
              {saveStateLabel}
            </span>
            <button className="preview-button" onClick={viewModel.openPreview} type="button"><PanelTop size={16} /> 预览方案</button><span className="avatar">FD</span>
          </div>
        </header>
        {isReadOnly && <ConflictBanner conflicts={viewModel.conflicts} channelHealthy={viewModel.channelHealthy} onResolve={viewModel.resolveConflict} />}
        <div className="workspace-content">
          <div className="page-heading"><div><span className="eyebrow">DESK PLANNER / {new Date().getFullYear()}</span><h1>把桌面，变成一张清晰的地图。</h1><p>先放置，再调整。每个尺寸与间距都在你的掌控之中。</p></div><div className="feedback-chip"><span className={viewModel.status === 'error' || isReadOnly ? 'feedback-icon error' : 'feedback-icon'}>{isReadOnly ? <Lock size={14} /> : viewModel.status === 'error' ? <TriangleAlert size={14} /> : <Check size={14} />}</span>{viewModel.feedback}</div></div>
          <div className="metrics-row"><div className="metric-card"><span>桌面尺寸</span><strong>{activePlan.deskWidthMm} <i>×</i> {activePlan.deskHeightMm}<small>mm</small></strong><em>可用面积</em></div><div className="metric-card"><span>已放置设备</span><strong>{activePlan.items.length}<small>件</small></strong><em>点击设备可编辑</em></div><div className={`metric-card ${analysis.status === 'attention' ? 'metric-warning' : ''}`}><span>空间检查</span><strong>{issueCount === 0 ? '通过' : `${issueCount} 个问题`}</strong><em>{issueCount === 0 ? '布局目前很舒展' : '请查看红色标记'}</em></div><div className="coverage-card"><div><span>占用率</span><strong>{analysis.coveragePercent}%</strong></div><div className="coverage-bar"><span style={{ width: `${Math.max(4, analysis.coveragePercent)}%` }} /></div><small>设备投影面积 / 桌面面积</small></div></div>
          <div className="editor-grid"><DevicePalette devices={DEVICE_DEFINITIONS} readOnly={isReadOnly} onAdd={viewModel.addItem} /><section className="stage-panel"><div className="stage-header"><div><span className="eyebrow">LIVE CANVAS</span><h2>{activePlan.name}</h2></div><div className={`status-pill ${analysis.status === 'attention' ? 'status-attention' : ''}`}>{analysis.status === 'attention' ? <TriangleAlert size={14} /> : <FileCheck2 size={14} />}{analysis.status === 'attention' ? '需要调整' : '布局健康'}</div></div><CanvasStage plan={activePlan} selectedItemId={selectedItem?.id ?? null} analysis={analysis} readOnly={isReadOnly} onSelect={viewModel.selectItem} onMove={viewModel.moveItem} /></section><InspectorPanel plan={activePlan} item={selectedItem} issueIds={issueIds} readOnly={isReadOnly} onUpdateDesk={viewModel.updateDesk} onUpdateItem={viewModel.updateItem} onRotate={viewModel.rotateItem} onDelete={viewModel.removeItem} /></div>
        </div>
      </section>
      {viewModel.isPreviewOpen && <PreviewOverlay plan={activePlan} analysis={analysis} issueCount={issueCount} onClose={viewModel.closePreview} />}
    </main>
  )
}
