import type { ApprovalStep, RfaStatus } from './types';

export const APP_VERSION = '1.0.0';

export const SHEETS = {
  USERS: ['USER_ID', 'FULL_NAME', 'EMAIL', 'DEPARTMENT_ID', 'POSITION', 'CAN_CREATE_RFA', 'CAN_APPROVE_RFA', 'IS_ADMIN', 'ACTIVE', 'CREATED_AT', 'UPDATED_AT', 'CAN_IMPLEMENT_RFA'],
  DEPARTMENTS: ['DEPARTMENT_ID', 'DEPARTMENT_NAME', 'DEPARTMENT_CODE', 'ACTIVE', 'CREATED_AT', 'UPDATED_AT', 'DEPARTMENT_HEAD_USER_ID', 'IS_ACADEMIC'],
  DEPARTMENT_HEADS: ['HEAD_ID', 'DEPARTMENT_ID', 'USER_ID', 'ACTIVE', 'CREATED_AT', 'UPDATED_AT'],
  APPROVAL_MATRIX: ['MATRIX_ID', 'DEPARTMENT_ID', 'APPROVAL_STEP', 'APPROVER_USER_ID', 'SEQUENCE', 'REQUIRED', 'ACTIVE', 'CREATED_AT', 'UPDATED_AT'],
  RFA: ['RFA_ID', 'RFA_NUMBER', 'DATE_FILED', 'DEPARTMENT_ID', 'DEPARTMENT_NAME', 'REQUESTED_BY', 'REQUESTER_EMAIL', 'POSITION', 'REQUEST_TITLE', 'PURPOSE', 'BUDGET_ALLOCATION', 'TARGET_DATE', 'JUSTIFICATION', 'STATUS', 'CURRENT_STEP', 'CURRENT_APPROVER_USER_ID', 'CURRENT_APPROVER_EMAIL', 'CURRENT_MATRIX_ID', 'RESUME_MATRIX_ID', 'CREATED_AT', 'UPDATED_AT', 'SUBMITTED_AT', 'COMPLETED_AT', 'VERSION', 'IS_BUDGET_REQUEST', 'EXPENSE_CATEGORY_ID', 'REQUESTED_AMOUNT', 'APPROVED_AMOUNT', 'ACTUAL_AMOUNT', 'FISCAL_YEAR', 'ACTUAL_EXPENSE_RECORDED_AT', 'EXPENSE_CLASSIFICATION', 'INVOLVED_DEPARTMENT_ID', 'INVOLVED_DEPARTMENT_NAME', 'PURCHASE_REQUEST', 'RECOMMENDING_ALTERNATE_USER_ID', 'RECOMMENDING_ALTERNATE_NAME', 'INCLUDE_PRINCIPAL', 'INCLUDE_PROCUREMENT', 'INVOLVED_DEPARTMENT_IDS'],
  RFA_APPROVALS: ['APPROVAL_ID', 'RFA_ID', 'RFA_NUMBER', 'STEP', 'APPROVER_USER_ID', 'APPROVER_NAME', 'APPROVER_EMAIL', 'ACTION', 'REMARKS', 'TIMESTAMP'],
  RFA_ATTACHMENTS: ['ATTACHMENT_ID', 'RFA_ID', 'FILE_NAME', 'DRIVE_FILE_ID', 'MIME_TYPE', 'SIZE_BYTES', 'UPLOADED_BY', 'UPLOADED_AT'],
  RFA_AUDIT: ['LOG_ID', 'RFA_ID', 'ACTOR_NAME', 'ACTOR_EMAIL', 'ACTION', 'PREVIOUS_STATUS', 'NEW_STATUS', 'REMARKS', 'TIMESTAMP', 'METADATA_JSON'],
  NOTIFICATIONS: ['NOTIFICATION_ID', 'RFA_ID', 'RECIPIENT', 'RECIPIENT_EMAIL', 'NOTIFICATION_TYPE', 'SUBJECT', 'SENT_AT', 'STATUS', 'ERROR_MESSAGE', 'RETRY_COUNT'],
  SETTINGS: ['KEY', 'VALUE', 'DESCRIPTION', 'UPDATED_AT'],
  DEPARTMENT_BUDGETS: ['BUDGET_ID', 'DEPARTMENT_ID', 'FISCAL_YEAR', 'ORIGINAL_ALLOCATED_AMOUNT', 'ALLOW_OVER_BUDGET', 'STATUS', 'CREATED_BY', 'CREATED_AT', 'UPDATED_BY', 'UPDATED_AT'],
  EXPENSE_CATEGORIES: ['CATEGORY_ID', 'CATEGORY_NAME', 'DESCRIPTION', 'ACTIVE', 'CREATED_BY', 'CREATED_AT', 'UPDATED_BY', 'UPDATED_AT'],
  ROLES: ['ROLE_ID', 'TITLE', 'STAGE', 'CONDITION', 'EMAIL_ORDER', 'ALL_RFAS_ACCESS', 'USER_ID', 'ACTIVE', 'SORT', 'UPDATED_AT'],
  BACKUPS: ['BACKUP_DATE', 'FILE_NAME', 'FILE_ID', 'URL', 'REASON'],
  ARCHIVES: ['SCHOOL_YEAR', 'LABEL', 'SPREADSHEET_ID', 'RFA_COUNT', 'FISCAL_YEARS', 'ARCHIVED_AT', 'ARCHIVED_BY'],
  BUDGET_TRANSACTIONS: ['TRANSACTION_ID', 'BUDGET_ID', 'DEPARTMENT_ID', 'FISCAL_YEAR', 'RFA_ID', 'CATEGORY_ID', 'TRANSACTION_TYPE', 'AMOUNT', 'DESCRIPTION', 'REFERENCE', 'STATUS', 'CREATED_BY', 'CREATED_AT', 'UPDATED_BY', 'UPDATED_AT']
} as const;

export const APPROVAL_STEPS: ApprovalStep[] = [
  'PREPARED_BY',
  'RECOMMENDING_APPROVAL',
  'REVIEWED_AND_NOTED',
  'REVIEWED_BY',
  'NOTED_BY',
  'INVOLVED_DEPARTMENT_HEAD',
  'APPROVED_BY'
];

export const APPROVAL_SECTIONS = [
  'RECOMMENDING_APPROVAL',
  'REVIEWED_AND_NOTED',
  'APPROVED_BY'
] as const;

export const V2_APPROVAL_SECTIONS = [
  'REVIEWED_BY',
  'NOTED_BY',
  'INVOLVED_DEPARTMENT_HEAD',
  'APPROVED_BY'
] as const;

export const LEGACY_APPROVAL_SECTIONS = [
  'RECOMMENDING_APPROVAL',
  'REVIEWED_BY',
  'NOTED_BY',
  'APPROVED_BY'
] as const;

export const ASSIGNMENT_WORKFLOW_MARKER = 'RFA_ASSIGNMENTS_V1';
export const FIXED_WORKFLOW_MARKER = 'RFA_FIXED_V2';
export const OFFICIAL_WORKFLOW_MARKER = 'RFA_FIXED_V3';

export const STATUS: Record<RfaStatus, RfaStatus> = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PENDING_RECOMMENDING_APPROVAL: 'PENDING_RECOMMENDING_APPROVAL',
  PENDING_REVIEW: 'PENDING_REVIEW',
  PENDING_AUTHORITY_APPROVAL: 'PENDING_AUTHORITY_APPROVAL',
  RETURNED: 'RETURNED',
  DISAPPROVED: 'DISAPPROVED',
  APPROVED: 'APPROVED',
  IMPLEMENTATION: 'IMPLEMENTATION',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  EXCEPTION: 'EXCEPTION'
};

export const STEP_STATUS: Record<ApprovalStep, RfaStatus> = {
  PREPARED_BY: 'SUBMITTED',
  RECOMMENDING_APPROVAL: 'PENDING_RECOMMENDING_APPROVAL',
  REVIEWED_AND_NOTED: 'PENDING_REVIEW',
  REVIEWED_BY: 'PENDING_REVIEW',
  NOTED_BY: 'PENDING_AUTHORITY_APPROVAL',
  INVOLVED_DEPARTMENT_HEAD: 'PENDING_REVIEW',
  APPROVED_BY: 'PENDING_AUTHORITY_APPROVAL'
};

export const DEFAULT_SETTINGS = [
  ['APP_NAME', 'eRFA', 'Application display name'],
  ['GOOGLE_CLIENT_ID', '', 'OAuth web client ID used to verify Google ID tokens'],
  ['ALLOWED_DOMAIN', '', 'Optional Google Workspace domain restriction'],
  ['FRONTEND_URL', '', 'Published GitHub Pages application URL'],
  ['ATTACHMENT_ROOT_FOLDER_ID', '', 'Drive root folder ID; created by setupDatabase when blank'],
  ['MAX_ATTACHMENT_BYTES', '10000000', 'Maximum attachment size in bytes'],
  ['EMAIL_ENABLED', 'TRUE', 'Send real email notifications through MailApp'],
  ['LAST_RFA_YEAR', '0', 'Internal numbering state'],
  ['LAST_RFA_SEQUENCE', '0', 'Internal numbering state'],
  ['REMINDERS_ENABLED', 'TRUE', 'Daily reminder emails to approvers who keep an RFA waiting (TRUE/FALSE)'],
  ['REMINDER_DAYS', '3', 'Days an RFA may wait before its approvers are reminded (repeats every this many days)'],
  ['VISIBLE_PAST_SCHOOL_YEARS', '2', 'How many past school years stay visible in the app. Older years are kept in Drive (archives and backups) but hidden.'],
  ['AUTO_MAINTENANCE', 'OFF', 'ON after installAutomaticMaintenance: monthly backup on the 1st, yearly archive on the 15th of the school-year start month.'],
  ['SCHOOL_YEAR_START_MONTH', '6', 'First month of the school year (1-12). Used for yearly archives: 6 = June to May.'],
  ['PRESIDENT_THRESHOLD_PHP', '50000', 'Presidential approval threshold in PHP (inclusive)'],
  ['REVIEWED_MANDATORY_USER_ID', '', 'Role: Reviewed and Noted By (mandatory) - user ID'],
  ['APPROVED_MANDATORY_USER_IDS', '', 'Roles: Approved By - AVP for Finance (first), VP for Admin and Finance (second) - user IDs, in this order'],
  ['VP_ACADEMIC_USER_ID', '', 'Role: VP for Academic Affairs - user ID'],
  ['PRESIDENT_USER_ID', '', 'Role: President - user ID'],
  ['PRINCIPAL_USER_ID', '', 'Role: JHS/SHS Principal - user ID'],
  ['PROCUREMENT_USER_ID', '', 'Role: Procurement - user ID'],
  ['VP_ADMIN_FINANCE_EMAIL', 'vp.finance@example.edu', 'Email of the VP for Admin and Finance role (used only while that role is unassigned; follows Approval settings)'],
  ['PRESIDENT_EMAIL', 'president@example.edu', 'Email of the President role (used only while that role is unassigned; follows Approval settings)']
] as const;

export const ALLOWED_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];
