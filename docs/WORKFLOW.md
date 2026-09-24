# Workflow

## Primary path

1. An authenticated user with `CAN_CREATE_RFA` saves a draft. eRFA assigns a locked, unique number such as `RFA-2026-0001`.
2. Submission validates all institutional form fields and records `PREPARED_BY` electronically.
3. The requester-selected active approvers are saved as the RFA's immutable route: Recommending Approval, Reviewed By, Noted By, then Approved By.
4. Only the employees in the first non-empty stage receive a direct **View RFA** email link and see the RFA under **For My Action**.
5. Each selected employee's action is appended to history. A stage advances only after every selected employee approves; then the next non-empty stage is activated and emailed.
6. After the final selected stage approves, status becomes `APPROVED` and the requester is notified. If every selectable stage is empty, the RFA completes without leaving a pending route.
7. The requester or an administrator can move the RFA to `IMPLEMENTATION`, then `CLOSED` for audit filing.

## Self-approval and invalid routes

The requester is excluded from the selectable employee directory and the backend revalidates every submitted user ID against the active directory. Duplicate selections within one stage and inactive, missing, or self assignments are rejected. Empty stages are audited as skipped without fake approval records or email.

Historical RFAs that already use the Approval Matrix retain their matrix routing, including its existing self-conflict and invalid-route behavior.

## Return and resubmission

Return requires remarks, records the returning stage, clears the active assignment, and emails the requester. The requester may edit institutional request fields, attachments, and (for new RFAs) the saved employee route. Resubmission restarts the new saved route; legacy RFAs resume their preserved matrix route.

## Disapproval

Disapproval requires remarks, records the final decision, clears the current assignment, and emails the requester. It does not erase prior approval or audit history.
# Financial RFA lifecycle

For a financial RFA, final approval creates a single budget commitment. Recording an actual expense releases that commitment and writes an actual-expense ledger row. Pending and returned RFAs do not affect budget availability. See [Budget Management](BUDGET_MANAGEMENT.md).
