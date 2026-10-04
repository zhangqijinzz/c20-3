import { FileDiff, Lock, ShieldCheck, Users } from 'lucide-react'
import type { ConflictDetail } from '../../sync/threeWayMerge'
import type { MergePreference } from '../../sync/threeWayMerge'

interface ConflictBannerProps {
  conflicts: ConflictDetail[]
  channelHealthy: boolean
  onResolve: (preference: MergePreference) => void
}

function describeKind(kind: ConflictDetail['kind']): string {
  switch (kind) {
    case 'bothCreated':
      return '两边各自新建了同号方案'
    case 'remoteEditedLocalDeleted':
      return '其他窗口改了它，本窗口删除了它'
    case 'localEditedRemoteDeleted':
      return '本窗口改了它，其他窗口删除了它'
    case 'edited':
    default:
      return '两边同时修改了它'
  }
}

export function ConflictBanner({ conflicts, channelHealthy, onResolve }: ConflictBannerProps) {
  return (
    <div className="conflict-banner" role="alert">
      <div className="conflict-banner-main">
        <span className="conflict-banner-icon"><Lock size={16} /></span>
        <div className="conflict-banner-copy">
          <strong>本窗口已切换为只读 <span className="conflict-readonly-tag">READ ONLY</span></strong>
          <p>
            {conflicts.length > 0
              ? `与其他窗口在同一方案上产生冲突（${conflicts.map((conflict) => `${conflict.planName}：${describeKind(conflict.kind)}`).join('；')}）。请选择保留哪一边，选择后自动恢复编辑。`
              : '本窗口的数据已落后于其他窗口，正在等待同步恢复。'}
          </p>
        </div>
      </div>
      <div className="conflict-banner-actions">
        <button className="conflict-choice" type="button" onClick={() => onResolve('remote')}>
          <Users size={15} />
          <span><strong>以其他窗口为准</strong><small>本窗口不冲突的改动仍保留</small></span>
        </button>
        <button className="conflict-choice conflict-choice-local" type="button" onClick={() => onResolve('local')}>
          <ShieldCheck size={15} />
          <span><strong>以本窗口为准</strong><small>对方不冲突的改动仍保留</small></span>
        </button>
        <span className="conflict-banner-hint"><FileDiff size={13} /> 不会无声覆盖任何一边</span>
      </div>
      {!channelHealthy && <p className="conflict-channel-warning">同步通道不可用，窗口间将在切换回来时通过存储核对，冲突仍会被拦截。</p>}
    </div>
  )
}
