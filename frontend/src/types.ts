export type RfaStatus = 'DRAFT' | 'SUBMITTED' | 'PENDING_RECOMMENDING_APPROVAL' | 'PENDING_REVIEW' | 'PENDING_AUTHORITY_APPROVAL' | 'RETURNED' | 'DISAPPROVED' | 'APPROVED' | 'IMPLEMENTATION' | 'CLOSED' | 'CANCELLED' | 'EXCEPTION';
export type ApprovalStep = 'PREPARED_BY' | 'RECOMMENDING_APPROVAL' | 'REVIEWED_AND_NOTED' | 'REVIEWED_BY' | 'NOTED_BY' | 'INVOLVED_DEPARTMENT_HEAD' | 'APPROVED_BY';
export type ApprovalSection = 'RECOMMENDING_APPROVAL' | 'REVIEWED_AND_NOTED' | 'REVIEWED_BY' | 'NOTED_BY' | 'INVOLVED_DEPARTMENT_HEAD' | 'APPROVED_BY';

export interface SessionUser {
  USER_ID: string; FULL_NAME: string; EMAIL: string; DEPARTMENT_ID: string; DEPARTMENT_NAME: string; POSITION: string;
  CAN_CREATE_RFA: boolean; CAN_APPROVE_RFA: boolean; CAN_IMPLEMENT_RFA: boolean; IS_ADMIN: boolean; ACTIVE: boolean;
  /** Access to the institution-wide All RFAs register: everything, approved RFAs only (Procurement), or none. */
  ALL_RFAS_SCOPE?: 'all' | 'approved' | 'none';
}
export interface Department { DEPARTMENT_ID: string; DEPARTMENT_NAME: string; DEPARTMENT_CODE: string; ACTIVE: boolean; CREATED_AT: string; UPDATED_AT: string; DEPARTMENT_HEAD_USER_ID?: string; IS_ACADEMIC?: boolean }
export interface DepartmentHead { HEAD_ID: string; DEPARTMENT_ID: string; USER_ID: string; ACTIVE: boolean; CREATED_AT: string; UPDATED_AT: string }
export interface User extends Omit<SessionUser, 'DEPARTMENT_NAME'> { CREATED_AT: string; UPDATED_AT: string }
export interface Matrix { MATRIX_ID: string; DEPARTMENT_ID: string; APPROVAL_STEP: ApprovalStep; APPROVER_USER_ID: string; SEQUENCE: number; REQUIRED: boolean; ACTIVE: boolean }
export interface Rfa {
  RFA_ID: string; RFA_NUMBER: string; DATE_FILED: string; DEPARTMENT_ID: string; DEPARTMENT_NAME: string; REQUESTED_BY: string;
  REQUESTER_EMAIL: string; POSITION: string; REQUEST_TITLE: string; PURPOSE: string; BUDGET_ALLOCATION: number; TARGET_DATE: string;
  JUSTIFICATION: string; STATUS: RfaStatus; CURRENT_STEP: ApprovalStep | ''; CURRENT_APPROVER_USER_ID: string; CURRENT_APPROVER_EMAIL: string; CURRENT_MATRIX_ID: string;
  CREATED_AT: string; UPDATED_AT: string; SUBMITTED_AT: string; COMPLETED_AT: string; VERSION: number;
  IS_BUDGET_REQUEST: boolean; EXPENSE_CATEGORY_ID: string; REQUESTED_AMOUNT: number; APPROVED_AMOUNT: number; ACTUAL_AMOUNT: number; FISCAL_YEAR: string; ACTUAL_EXPENSE_RECORDED_AT: string;
  EXPENSE_CLASSIFICATION?: string; INVOLVED_DEPARTMENT_ID?: string; INVOLVED_DEPARTMENT_NAME?: string;
  PURCHASE_REQUEST?: boolean; RECOMMENDING_ALTERNATE_USER_ID?: string; RECOMMENDING_ALTERNATE_NAME?: string; INCLUDE_PRINCIPAL?: boolean; INCLUDE_PROCUREMENT?: boolean; INVOLVED_DEPARTMENT_IDS?: string;
}
export interface Approval { APPROVAL_ID: string; STEP: ApprovalStep; APPROVER_USER_ID: string; APPROVER_NAME: string; APPROVER_EMAIL: string; ACTION: string; REMARKS: string; TIMESTAMP: string }
export interface EligibleApprover { USER_ID: string; FULL_NAME: string; EMAIL: string; POSITION: string; DEPARTMENT: string }
export type ApprovalAssignments = Record<ApprovalSection, string[]>;
export type EmployeeDirectory = EligibleApprover[];
export interface Attachment { ATTACHMENT_ID: string; FILE_NAME: string; MIME_TYPE: string; SIZE_BYTES: number; UPLOADED_BY: string; UPLOADED_AT: string }
export interface Audit { LOG_ID: string; ACTOR_NAME: string; ACTOR_EMAIL: string; ACTION: string; PREVIOUS_STATUS: string; NEW_STATUS: string; REMARKS: string; TIMESTAMP: string }
export interface FinancialDetail { fiscalYear: string; categoryName: string; requestedAmount: number; approvedAmount: number; actualAmount: number; projectedAvailable: number | null; expenseClassification?: string; involvedDepartmentId?: string; involvedDepartmentName?: string; purchaseRequest?: boolean; includePrincipal?: boolean; includeProcurement?: boolean; involvedDepartmentIds?: string; recommendingAlternateName?: string; budget: { allocated: number; committed: number; actualSpent: number; available: number; utilization: number } | null }
export interface RfaDetail { rfa: Rfa; approvals: Approval[]; attachments: Attachment[]; audit: Audit[]; notedByNotApplicable: boolean; financial: FinancialDetail | null; permissions: { canEdit: boolean; canDecide: boolean; canImplement: boolean; canClose: boolean; canRecordActualExpense: boolean } }
export interface AdminData { users: User[]; departments: Department[]; matrix: Matrix[]; heads?: DepartmentHead[]; settings?: { presidentThresholdPhp: string; reviewedMandatoryUserId: string; approvedMandatoryUserIds: string; vpAcademicUserId: string; presidentUserId: string; principalUserId: string; procurementUserId?: string; vpAdminFinanceEmail?: string; presidentEmail?: string }; audit: Array<Record<string,string>>; notifications: Array<Record<string,string>> }
