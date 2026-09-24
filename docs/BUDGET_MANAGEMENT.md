# Department Budget & Expenditure Management

Phase 9 extends eRFA with a department and fiscal-year ledger. It does not replace the RFA approval workflow.

## Financial model

New money fields and ledger amounts are stored as integer centavos. The UI and API present them as PHP amounts. The available balance is always derived as:

`allocated + adjustments - active commitments - actual expenses`

`DEPARTMENT_BUDGETS` identifies a department/FY budget. Its initial allocation and every later adjustment are immutable `BUDGET_TRANSACTIONS`; no mutable remaining-balance field exists.

## RFA lifecycle

Financial information is optional. A draft or submitted financial RFA creates no budget transaction. Final approval creates one idempotent `COMMITMENT` under the existing ScriptLock after the ledger has been re-read. If over-budget is disabled, insufficient funds block the final approval before its status update.

An implementer or administrator can record the actual expense. This writes a `COMMITMENT_RELEASE` and `ACTUAL_EXPENSE` exactly once for the RFA, returning any unused commitment to the derived available balance. Ledger history is append-only; corrections use adjustment or reversal entries rather than deletion.

## Administration and reporting

Administrators create one budget per department/FY, make reasoned increases or decreases, set the over-budget policy, and manage active expense categories. Inactive categories remain in history but cannot be selected for a new financial RFA. The Budget Management and Department Expense Reports routes are admin-only in both the UI and Apps Script API. The report export is filtered CSV and includes the report identity, FY, rows, and totals.

## Migration and operations

Run `setupDatabase()` after deploying the Apps Script bundle. It appends RFA financial columns and creates `DEPARTMENT_BUDGETS`, `EXPENSE_CATEGORIES`, and `BUDGET_TRANSACTIONS` without deleting, reordering, or clearing any existing data. Existing blank rows are treated as non-financial RFAs.
