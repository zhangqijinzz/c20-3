import { createItem, getDeviceDefinition, type DeskItem, type DeviceType } from '../../shared/models'

export interface MaterialDraft {
  item: DeskItem
  feedback: string
}

export function createMaterialDraft(type: DeviceType, currentItemCount: number): MaterialDraft {
  return {
    item: createItem(type, currentItemCount),
    feedback: `${getDeviceDefinition(type).label}已添加`,
  }
}
