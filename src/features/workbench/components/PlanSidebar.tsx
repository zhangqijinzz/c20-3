import { Copy, LayoutGrid, Plus, Trash2 } from 'lucide-react'
import type { WorkspacePlan } from '../../../shared/models'

interface PlanSidebarProps {
  plans: WorkspacePlan[]
  activePlanId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: () => void
  onDelete: () => void
}

export function PlanSidebar({ plans, activePlanId, onSelect, onCreate, onDuplicate, onDelete }: PlanSidebarProps) {
  return (
    <aside className="plans-sidebar">
      <div className="brand-lockup"><span className="brand-mark"><LayoutGrid size={18} /></span><span>FocusDesk</span></div>
      <div className="sidebar-label"><span>我的工作台</span><span className="plan-total">{plans.length}</span></div>
      <div className="plan-list">
        {plans.map((plan, index) => (
          <button className={`plan-card ${plan.id === activePlanId ? 'is-active' : ''}`} key={plan.id} onClick={() => onSelect(plan.id)} type="button">
            <span className="plan-number">0{index + 1}</span>
            <span className="plan-card-copy"><strong>{plan.name}</strong><small>{plan.items.length} 件设备 · {plan.deskWidthMm} × {plan.deskHeightMm} mm</small></span>
            {plan.id === activePlanId && <span className="active-dot" />}
          </button>
        ))}
      </div>
      <button className="new-plan-button" onClick={onCreate} type="button"><Plus size={16} /> 新建方案</button>
      <div className="sidebar-footer">
        <button className="ghost-action" onClick={onDuplicate} type="button"><Copy size={15} /> 复制当前方案</button>
        <button className="ghost-action danger-action" onClick={onDelete} type="button"><Trash2 size={15} /> 删除当前方案</button>
      </div>
    </aside>
  )
}
