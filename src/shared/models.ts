export type DeviceType = 'monitor' | 'keyboard' | 'lamp' | 'speaker' | 'stand'

export type WorkspaceStatus = 'loading' | 'ready' | 'saving' | 'error'

export interface DeskItem {
  id: string
  type: DeviceType
  widthMm: number
  heightMm: number
  x: number
  y: number
  rotation: number
}

export interface WorkspacePlan {
  id: string
  name: string
  deskWidthMm: number
  deskHeightMm: number
  items: DeskItem[]
  updatedAt: string
}

export interface WorkspaceDocument {
  version: 1
  plans: WorkspacePlan[]
  activePlanId: string
}

export interface ItemBounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface LayoutAnalysis {
  overlapIds: string[]
  outOfBoundsIds: string[]
  coveragePercent: number
  status: 'clear' | 'attention'
}

export interface DeviceDefinition {
  type: DeviceType
  label: string
  shortLabel: string
  widthMm: number
  heightMm: number
  color: string
  hint: string
}

export const DEVICE_DEFINITIONS: DeviceDefinition[] = [
  { type: 'monitor', label: '显示器', shortLabel: 'MON', widthMm: 540, heightMm: 210, color: '#93b7ff', hint: '主屏 / 副屏' },
  { type: 'keyboard', label: '键盘', shortLabel: 'KEY', widthMm: 440, heightMm: 150, color: '#b5ead7', hint: '全尺寸 / 75%' },
  { type: 'lamp', label: '桌面灯', shortLabel: 'LAMP', widthMm: 180, heightMm: 180, color: '#ffd58e', hint: '灯座占用' },
  { type: 'speaker', label: '音箱', shortLabel: 'SPK', widthMm: 150, heightMm: 150, color: '#f4b7d4', hint: '左右声道' },
  { type: 'stand', label: '支架', shortLabel: 'STAND', widthMm: 260, heightMm: 180, color: '#cbb7f7', hint: '支架 / 坞站' },
]

export const DEFAULT_DESK = { widthMm: 1600, heightMm: 800 }

export function getDeviceDefinition(type: DeviceType): DeviceDefinition {
  return DEVICE_DEFINITIONS.find((device) => device.type === type) ?? DEVICE_DEFINITIONS[0]
}

export function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createItem(type: DeviceType, index = 0): DeskItem {
  const definition = getDeviceDefinition(type)
  const columns = 3
  const x = 80 + (index % columns) * 280
  const y = 90 + Math.floor(index / columns) * 240
  return {
    id: createId('item'),
    type,
    widthMm: definition.widthMm,
    heightMm: definition.heightMm,
    x,
    y,
    rotation: 0,
  }
}

export function createPlan(name = '我的工作台', withDemo = true): WorkspacePlan {
  const items = withDemo ? [createItem('monitor', 0), createItem('keyboard', 1)] : []
  if (withDemo) {
    items[0].x = 530
    items[0].y = 105
    items[1].x = 580
    items[1].y = 470
  }
  return {
    id: createId('plan'),
    name,
    deskWidthMm: DEFAULT_DESK.widthMm,
    deskHeightMm: DEFAULT_DESK.heightMm,
    items,
    updatedAt: new Date().toISOString(),
  }
}

export function createInitialDocument(): WorkspaceDocument {
  const plan = createPlan('我的工作台', true)
  return { version: 1, plans: [plan], activePlanId: plan.id }
}
