/** Composer adapter for one pending tool-approval waterfall. */
import type { ApprovalComposerProps } from './contract/slots.ts'

/**
 * Render the shared card using the tool approval's one-shot decision policy.
 * The Always-allow button appears only when the composition can record a
 * remembered grant for this ask; a refused recording settles nothing, so the
 * ask stays open and Allow/Reject keep working.
 * @param props Selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const reason = approval.displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason)
  return props.renderFactorySlot('conversation.approval.card', {
    requestKey: approval.key,
    title: reason ?? props.t('escalation', { toolName: approval.toolName }),
    ...(approval.callId === undefined ? {} : { callId: approval.callId }),
    canAnswer: () => approval.answerable,
    onAllow: () => approval.answer('allowed-once'),
    onReject: () => approval.answer('rejected'),
    ...(props.remember === undefined ? {} : {
      onAlways: async () => {
        if (await props.remember!(approval)) await approval.answer('allowed-once')
      },
    }),
  })
}
