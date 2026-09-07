# Google Sheets Database

`setupDatabase()` creates or validates the spreadsheet, headers, formatting, default settings, and private Drive root. It is additive: it creates missing tabs and empty header cells but refuses to replace a conflicting header. Existing data is not cleared.

## Sheets

### USERS

Stable user identity, profile, and independent `CAN_CREATE_RFA`, `CAN_APPROVE_RFA`, `CAN_IMPLEMENT_RFA`, `IS_ADMIN`, and `ACTIVE` capabilities. Deactivation is soft.

### DEPARTMENTS

Configurable department name, code, active state, and timestamps. No department names are seeded.

### APPROVAL_MATRIX

Department, institutional approval step, approver user ID, sequence, required flag, active flag, and timestamps. Supported routed steps are `RECOMMENDING_APPROVAL`, `REVIEWED_AND_NOTED`, and `APPROVED_BY`; `PREPARED_BY` is the authenticated requester at submission.

### RFA

The supplied form fields plus stable IDs, number, derived requester profile, status, current assignment, return-resume route, timestamps, and version. Monetary values are stored as numbers and dates as ISO strings.

### RFA_APPROVALS

Append-only decisions with step, approver identity, action, remarks, and server timestamp. Actions include `APPROVED`, `RETURNED`, `DISAPPROVED`, `SKIPPED`, and `EXCEPTION`.

### RFA_ATTACHMENTS

Metadata only. Binary content remains in private Drive folders under `eRFA/<year>/<RFA number>`.

### RFA_AUDIT

Append-only actor, action, previous/new status, remarks, timestamp, and bounded JSON metadata. The UI excludes raw metadata from ordinary RFA detail responses.

### NOTIFICATIONS

Real delivery attempts with recipient, type, subject, sent timestamp, status, error message, and retry count. Failures are never silently treated as sent.

### SETTINGS

Configuration and internal numbering state. Required deployment values are `GOOGLE_CLIENT_ID` and `FRONTEND_URL`; `ALLOWED_DOMAIN` is optional. `ATTACHMENT_ROOT_FOLDER_ID` is created automatically. No secret belongs in this sheet or the frontend.
