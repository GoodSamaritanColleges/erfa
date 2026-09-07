export type SheetRecord = Record<string, string | number | boolean>;

export interface UserRecord extends SheetRecord {
  USER_ID: string;
  FULL_NAME: string;
  EMAIL: string;
  DEPARTMENT_ID: string;
  POSITION: string;
  CAN_CREATE_RFA: boolean;
  CAN_APPROVE_RFA: boolean;
  CAN_IMPLEMENT_RFA: boolean;
  IS_ADMIN: boolean;
  ACTIVE: boolean;
  CREATED_AT: string;
  UPDATED_AT: string;
}

export interface DepartmentRecord extends SheetRecord {
  DEPARTMENT_ID: string;
  DEPARTMENT_NAME: string;
  DEPARTMENT_CODE: string;
  ACTIVE: boolean;
  CREATED_AT: string;
  UPDATED_AT: string;
}

export interface MatrixRecord extends SheetRecord {
  MATRIX_ID: string;
  DEPARTMENT_ID: string;
  APPROVAL_STEP: ApprovalStep;
  APPROVER_USER_ID: string;
  SEQUENCE: number;
  REQUIRED: boolean;
  ACTIVE: boolean;
  CREATED_AT: string;
  UPDATED_AT: string;
}

export interface RfaRecord extends SheetRecord {
  RFA_ID: string;
  RFA_NUMBER: string;
  DATE_FILED: string;
  DEPARTMENT_ID: string;
  DEPARTMENT_NAME: string;
  REQUESTED_BY: string;
  REQUESTER_EMAIL: string;
  POSITION: string;
  REQUEST_TITLE: string;
  PURPOSE: string;
  BUDGET_ALLOCATION: number;
  TARGET_DATE: string;
  JUSTIFICATION: string;
  STATUS: RfaStatus;
  CURRENT_STEP: ApprovalStep | '';
  CURRENT_APPROVER_USER_ID: string;
  CURRENT_APPROVER_EMAIL: string;
  CURRENT_MATRIX_ID: string;
  RESUME_MATRIX_ID: string;
  CREATED_AT: string;
  UPDATED_AT: string;
  SUBMITTED_AT: string;
  COMPLETED_AT: string;
  VERSION: number;
}

export type ApprovalStep =
  | 'PREPARED_BY'
  | 'RECOMMENDING_APPROVAL'
  | 'REVIEWED_AND_NOTED'
  | 'REVIEWED_BY'
  | 'NOTED_BY'
  | 'APPROVED_BY';

export type RfaStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PENDING_RECOMMENDING_APPROVAL'
  | 'PENDING_REVIEW'
  | 'PENDING_AUTHORITY_APPROVAL'
  | 'RETURNED'
  | 'DISAPPROVED'
  | 'APPROVED'
  | 'IMPLEMENTATION'
  | 'CLOSED'
  | 'CANCELLED'
  | 'EXCEPTION';

export interface SessionUser extends UserRecord {
  DEPARTMENT_NAME: string;
}

export interface RfaApprovalAssignment {
  USER_ID: string;
  USER_NAME: string;
  POSITION: string;
  DEPARTMENT: string;
  EMAIL: string;
  STATUS: 'PENDING' | 'APPROVED' | 'RETURNED' | 'DISAPPROVED';
  ACTION_AT: string;
  COMMENTS: string;
}

export interface EligibleApprover {
  USER_ID: string;
  FULL_NAME: string;
  EMAIL: string;
  POSITION: string;
  DEPARTMENT: string;
}

export type ApprovalSection =
  | 'RECOMMENDING_APPROVAL'
  | 'REVIEWED_BY'
  | 'NOTED_BY'
  | 'APPROVED_BY';

export type RfaSectionAssignments = Record<ApprovalSection, EligibleApprover[]>;
