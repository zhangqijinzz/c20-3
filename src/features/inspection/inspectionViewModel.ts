import { analyzeLayout } from '../../shared/layoutRules'
import type { LayoutAnalysis, WorkspacePlan } from '../../shared/models'

export interface InspectionState {
  analysis: LayoutAnalysis
  issueIds: string[]
  issueCount: number
}

export function inspectPlan(plan: WorkspacePlan): InspectionState {
  const analysis = analyzeLayout(plan)
  const issueIds = [...new Set([...analysis.overlapIds, ...analysis.outOfBoundsIds])]
  return { analysis, issueIds, issueCount: issueIds.length }
}
