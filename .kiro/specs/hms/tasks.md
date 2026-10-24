# Implementation Plan

Ordered, independently testable tasks for the HMS MVP. The priority is one polished end-to-end vertical slice. Build the stable core first, then domain modules, then transport, then wire the demo. No SMS code at any point.

- [ ] 1. Project initialization & tooling
  - Scaffold a Node.js + TypeScript project with a single `npm run dev` start.
  - Create the directory structure that enforces module boundaries: `core/`, `modules/queue/`, `modules/prescription/`, `modules/pharmacy/`, `transport/web/`, `transport/email/`.
  - Add `.env` loading; document `DATABASE_URL`, `SESSION_SECRET`, and email provider vars in `.env.example` (never hardcode secrets).
  - Configure the test runner (Vitest/Jest + Supertest).
  - _Requirements: NFR (modular architecture, deployment, security)_

- [ ] 2. Core layer: data access & entities
- [ ] 2.1 Define schema/models and migrations for StaffUser, Patient, QueueEntry, Visit, Prescription, Dispensing, AccessGrant, AuditRecord, NotificationJob.
  - Normalize email to lowercase and phone to E.164; store PII encrypted at rest; timestamps in UTC.
  - _Requirements: 2.1, 2.2, 2.7, NFR (security, data)_
- [ ] 2.2 Implement the entity store as the single data-access boundary (no module touches the DB directly).
  - _Requirements: NFR (modular architecture)_
- [ ] 2.3 Implement the immutable audit service; append a record on every mutation.
  - _Requirements: 4.7, NFR (data)_

- [ ] 3. Core layer: access control
- [ ] 3.1 Implement the access control service as the single authorization gate for every read/write.
  - _Requirements: 7.1, 7.2_
- [ ] 3.2 Enforce patient isolation and doctor history-access gating (active/past visit, patient grant, peer-doctor grant), including grant expiry and revocation.
  - _Requirements: 4.2, 7.4_
- [ ] 3.3 Enforce doctor-as-patient isolation and pharmacy scope limits (active plan only).
  - _Requirements: 5.3, 7.3_
- [ ] 3.4 Unit-test the access control rules.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 4. Core layer: notification service (email)
- [ ] 4.1 Build the file-based email template system (no inline HTML in business logic) with templates for registration confirmation, visit summary, and prescription issued; every template includes an unsubscribe link.
  - _Requirements: 2.4, 4.5, NFR (email reliability)_
- [ ] 4.2 Implement the notification service with a NotificationJob queue, validation (format + MX where possible), send, and retry-on-failure. Triggering actions must never block or fail on email errors.
  - _Requirements: 2.5, NFR (email reliability, error handling)_
- [ ] 4.3 Test graceful degradation: force provider failure, assert the triggering action still succeeds and the job is queued/retried.
  - _Requirements: 2.5_

- [ ] 5. Auth & role selection (transport + core)
- [ ] 5.1 Implement login with signed session cookies and a generic invalid-credentials error.
  - _Requirements: 1.1, 1.4_
- [ ] 5.2 Implement active-role selection (prompt on multi-role, auto-select on single-role) and logout.
  - _Requirements: 1.2, 1.3, 1.5_
- [ ] 5.3 Authorize every request against the active role via the core access control service.
  - _Requirements: 1.6, 7.1_
- [ ] 5.4 Test valid/invalid login, multi-role vs single-role, and logout.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 6. Patient registration & lookup
- [ ] 6.1 Implement patient registration with mandatory input validation (reject, never silently drop) and unique normalized email.
  - _Requirements: 2.1, 2.2, 2.3, 2.7_
- [ ] 6.2 Trigger the registration confirmation email via the notification service.
  - _Requirements: 2.4, 2.5_
- [ ] 6.3 Implement search by name or patient ID.
  - _Requirements: 2.6_

- [ ] 7. Queue module
- [ ] 7.1 Add a registered patient to today's queue (status Waiting, UTC timestamp).
  - _Requirements: 3.1_
- [ ] 7.2 List today's queue ordered by wait time; support Waiting → In Progress → Completed transitions.
  - _Requirements: 3.2, 3.3, 3.4_

- [ ] 8. Consultation & prescription module
- [ ] 8.1 Open a visit from a queue entry (grants the doctor scoped access) and render the access-controlled patient summary with prior history.
  - _Requirements: 4.1, 4.2_
- [ ] 8.2 Save diagnosis/notes linked to the patient and visit; append audit records.
  - _Requirements: 4.3, 4.7_
- [ ] 8.3 Add medications, finalize the visit, generate a printable prescription, and mark it the active medication plan.
  - _Requirements: 4.4_
- [ ] 8.4 On finalize, mark the queue entry Completed and send visit-summary + prescription-issued emails (with pharmacy lookup link).
  - _Requirements: 4.5, 4.6_

- [ ] 9. Pharmacy module
- [ ] 9.1 Look up a patient's active medication plan via a valid prescription only (deny everything else at the data layer).
  - _Requirements: 5.1, 5.3_
- [ ] 9.2 Record dispensing events.
  - _Requirements: 5.2_

- [ ] 10. Admin / HR module
- [ ] 10.1 Per-department dashboard: today's counts (registered, in queue, completed) grouped by department, facility-scoped, with no patient-identifying data.
  - _Requirements: 6.1, 6.2, 6.3_
- [ ] 10.2 Staff invitations: create a single-use, time-limited tokenized invite; send the invite email; public activation page where the invitee sets name + password to create their account.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
- [ ] 10.3 Staff management: list staff (department + roles, no patient data) and update a staff member's roles/department with an audit record.
  - _Requirements: 7.5, 7.6, 7.7_
- [ ] 10.4 Facility information: view and edit the facility profile (name, address, phone, departments, specialties) with validation and audit.
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
- [ ] 10.5 Enforce that Admin can never register, search, or view patients.
  - _Requirements: 2.8, 9.6_

- [ ] 11. Integration: full demo vertical slice
  - Wire the end-to-end flow: register → email → queue → consult + prescribe → emails → pharmacy view → admin dashboard.
  - _Requirements: 1–7 (demo flow)_

- [ ] 12. Testing: core flow & access control
  - Integration test the full demo slice asserting emails enqueued and dashboard counts correct; run the access-control and email-degradation suites.
  - _Requirements: NFR (testing), 7.*_

- [ ] 13. UI polish
  - Clean, non-technical error messages everywhere; readable layout for low-resource/poor-connectivity use; printable prescription styling.
  - _Requirements: NFR (error handling)_

- [ ] 14. Deployment & seed data
  - Synthetic seed script (patients, staff with roles, demo logins) — no real PII; single-command local start; verify deployability to a free hosting tier.
  - _Requirements: NFR (deployment), Assumptions (synthetic data)_
