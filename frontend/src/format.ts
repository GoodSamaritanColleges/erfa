import type { ApprovalStep, RfaStatus } from './types';

export const statusLabel = (status: RfaStatus | string): string => ({
  DRAFT: 'Draft', SUBMITTED: 'Submitted', PENDING_RECOMMENDING_APPROVAL: 'Recommending Approval', PENDING_REVIEW: 'Reviewed & Noted',
  PENDING_AUTHORITY_APPROVAL: 'Authority Approval', RETURNED: 'Returned', DISAPPROVED: 'Disapproved', APPROVED: 'Approved',
  IMPLEMENTATION: 'Implementation', CLOSED: 'Closed', CANCELLED: 'Cancelled', EXCEPTION: 'Workflow Exception'
}[status] ?? status.replaceAll('_', ' '));

export const stepLabel = (step: ApprovalStep | string): string => ({
  PREPARED_BY: 'Prepared By', RECOMMENDING_APPROVAL: 'Recommending Approval', REVIEWED_AND_NOTED: 'Reviewed and Noted By', REVIEWED_BY: 'Reviewed By', NOTED_BY: 'Noted By', APPROVED_BY: 'Approved By'
}[step] ?? step.replaceAll('_', ' '));

export const money = (value: number | string): string => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
export const date = (value: string): string => value ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(value.length === 10 ? `${value}T00:00:00` : value)) : '—';
export const dateTime = (value: string): string => value ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
