# Administrator Guide

## Initial setup

Run `setupDatabase()` and then the one-time `bootstrapAdmin(realEmail, realName)` function from the Apps Script editor. This deliberate step avoids inventing an administrator. Set the OAuth client ID, frontend URL, and optional Workspace domain in `SETTINGS` before sign-in.

## Configuration order

1. Add active departments with unique names and codes.
2. Add users with their real Google email, department, position, capabilities, and active state.
3. Maintain each employee's active state, application access, department, and position. `Can Create RFA` enables requester access, `Can Approve RFA` makes an active employee selectable in every approval stage, and `Can Implement RFA` enables implementation and close actions. New RFA routes draw from active approvers; an employee's approval stage is chosen per RFA, not as a permanent role.
4. Keep the Approval Matrix only when historical RFAs still depend on its legacy routing records.
5. Use a real requester and approver to run the acceptance scenarios in `docs/TESTING.md`.

Requester and approver are not exclusive roles. The server rejects a requester who attempts to add themself to the same RFA's saved route.

Deactivate obsolete users, departments, or matrix routes instead of deleting spreadsheet rows. Historical RFAs continue to show the identities copied at the time of action.

The **System Logs** tab shows recent audit events and notification delivery results. `FAILED` contains the MailApp error; `PENDING` indicates email was disabled in settings. Correct the cause before manually retriggering a workflow event—do not edit a notification record to claim delivery.
