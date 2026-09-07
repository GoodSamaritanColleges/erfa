# API

The deployed Apps Script `/exec` endpoint accepts POST bodies shaped as:

```json
{"action":"rfa.detail","idToken":"GOOGLE_ID_TOKEN","payload":{"rfaId":"rfa_uuid"}}
```

Except for `health`, every action authenticates the Google token, checks the registered active user, and applies capability/resource rules.

## Actions

- `health`, `session`
- `rfa.list`, `rfa.forApproval`, `rfa.detail`, `rfa.eligibleApprovers`
- `rfa.create`, `rfa.update`, `rfa.submit`, `rfa.resubmit`
- `rfa.approve`, `rfa.return`, `rfa.disapprove`
- `rfa.implementation`, `rfa.close`, `rfa.cancel`
- `attachment.upload`, `attachment.download`
- `admin.data`, `admin.user.save`, `admin.department.save`, `admin.matrix.save`, `admin.database`

The API is an explicit allow-list. It exposes no arbitrary sheet read/write operation. Mutations run under a script lock. Error responses contain safe user-facing messages and stable categories such as `UNAUTHORIZED`, `NOT_REGISTERED`, `INACTIVE_USER`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, and `CONFIGURATION_REQUIRED`.

Attachments are base64-encoded only for the request/response boundary. The backend validates MIME type and decoded size, saves the file to private Drive storage, and returns metadata without a Drive file ID. Download requests re-check RFA access before reading the blob.
