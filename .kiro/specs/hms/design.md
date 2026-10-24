# Design Document

## Overview

This document describes the technical design for the Hospital Management System (HMS) MVP — a modular web platform that unifies patient records for a single rural / low-resource clinic. It realizes the vertical demo slice: register a patient, queue them, run a consultation with a prescription, notify the patient by email, expose the prescription to a pharmacy, and surface daily activity to an admin.

The design follows the steering's **modular information core** principle: a stable core layer owns entities, records, and access control; transport modules (web, email) and domain modules (queue, prescription, pharmacy) depend on the core and never on each other. SMS is deliberately absent — no stubs, libraries, or routing that assume it.

## Architecture

Three layers, with a strict one-way dependency rule (modules depend on core; core depends on nothing):

```
┌─────────────────────────────────────────────────────────────┐
│ Transport modules                                            │
│   • Web dashboard (server-rendered pages + REST endpoints)   │
│   • Email notification sender (template-based)               │
├─────────────────────────────────────────────────────────────┤
│ Domain modules                                               │
│   • Queue management   • Prescription   • Pharmacy access    │
├─────────────────────────────────────────────────────────────┤
│ Core layer (stable; depends on nothing)                      │
│   • Entities & records   • Access control / authorization    │
│   • Notification service (queues + retries email)            │
│   • Audit log (immutable)   • Data access (encrypted at rest)│
└─────────────────────────────────────────────────────────────┘
```

Rules enforced by directory boundaries:
- Transport code calls core service methods; it never touches the database directly.
- A domain module never imports from another domain module; both route through core services.
- All email is sent through the single core notification service; no module calls the email provider directly.

## Tech Stack

Chosen for a fast, free-tier-deployable, single-command demo. Final confirmation pending, but the defaults below satisfy every steering constraint.

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js + TypeScript | Single `npm run dev` start; typed core contracts. |
| Web framework | Express | Minimal, well understood, serves both pages and REST. |
| Views | Server-rendered templates (EJS/Handlebars) + light JS | Works on poor connectivity; no heavy SPA build. |
| Database | SQLite (local dev) → Postgres (deploy) | `DATABASE_URL` already in `.env.example`; both free-tier friendly. |
| ORM / query layer | Prisma (or Knex) | Single data-access boundary; easy migrations + seed script. |
| Auth / sessions | Signed session cookies | `SESSION_SECRET` already in `.env.example`. |
| Email | Provider-agnostic sender (e.g. Nodemailer transport) behind the core notification service | Swappable transport; queue + retry handled in core. |
| Email templates | File-based template system | Steering forbids inline HTML in business logic. |
| Testing | Vitest/Jest + Supertest | Covers core flow, login, and access control. |
| Hosting | Railway / Render / Fly.io | Free-tier target from steering. |

Secrets (`DATABASE_URL`, `SESSION_SECRET`, and email provider credentials) live only in the gitignored `.env`; `.env.example` documents them.

## Components

### Core layer
- **Entity store** — CRUD for Patient, StaffUser (with roles), Visit, Prescription, QueueEntry, DispensingRecord, AccessGrant, AuditRecord. Owns normalization (lowercase email, E.164 phone) and encryption-at-rest of PII.
- **Access control service** — single authorization gate. Given `(activeRole, actor, targetResource)` it returns allow/deny. Every data read/write passes through it.
- **Notification service** — the only component that sends email. Renders a named template with data, enqueues the message, sends, and retries on provider failure. Triggering actions never block on it.
- **Audit service** — appends immutable records for every write (who, what, when, before/after).

### Domain modules
- **Queue module** — add to queue, list today's queue ordered by wait time, transition Waiting → In Progress → Completed.
- **Prescription / consultation module** — create/finalize visits, attach medications, mark the active medication plan, generate a printable prescription.
- **Pharmacy module** — look up a patient's active medication plan via a valid prescription; record dispensing events.
- **Admin / HR module** — the Admin role is facility administration, not patient operations. It invites staff via single-use tokenized links, assigns staff to departments and roles, manages facility information, and views the dashboard as per-department aggregate counts. It has **no** access to patient records or patient-identifying data. Patient registration and search belong to Receptionists only.

### Transport modules
- **Web module** — login + role selection, receptionist screens (register, search, queue), doctor screens (patient summary, visit, prescription), pharmacy lookup screen, admin HR screens (invite staff, manage staff, facility info, per-department dashboard), and the public invite-activation page. Enforces access in UI *and* delegates authorization to the core access control service.
- **Email sender** — concrete email transport invoked only by the core notification service.

## Data Models

Representative core entities (illustrative; fields may be refined during implementation):

```
StaffUser   { id, email(lowercase, unique), passwordHash, name, phone?(E.164),
              facilityCode, department, roles: [Admin|Receptionist|Doctor|Pharmacy],
              createdAt(UTC) }

Facility    { code (unique), name, address, phone, departments: [string],
              specialties, updatedAt(UTC) }

StaffInvite { id, email(lowercase), roles: [Role], department, facilityCode,
              token(unique, single-use), status: pending|used|expired,
              expiresAt(UTC), usedAt?(UTC), createdAt(UTC) }

Patient     { id, email(lowercase, unique), name, phone?(E.164), nationalId?,
              address?, bloodType?, allergies?, emergencyContact?, createdAt(UTC) }
            // PII fields encrypted at rest

QueueEntry  { id, patientId, facilityCode, department, status: Waiting|InProgress|Completed,
              createdAt(UTC), updatedAt(UTC) }   // department drives admin counts

Visit       { id, patientId, doctorId, queueEntryId, facilityCode,
              diagnosis, notes, status: Open|Finalized, createdAt(UTC) }

Prescription{ id, visitId, patientId, medications: [{name, dosage, instructions}],
              isActivePlan: bool, pharmacyLookupToken, createdAt(UTC) }

Dispensing  { id, prescriptionId, pharmacyCode, itemsDispensed, dispensedAt(UTC) }

AccessGrant { id, patientId, grantedToDoctorId, grantedBy: patient|peerDoctor,
              expiresAt(UTC), revokedAt?(UTC) }

AuditRecord { id, actorId, actorRole, action, entity, entityId, before, after,
              at(UTC) }   // immutable

NotificationJob { id, template, toEmail, payload, status: queued|sent|failed,
                  attempts, lastError?, createdAt(UTC) }
```

## API Endpoints

REST endpoints served by the web module; all pass through the core access control service.

```
POST   /auth/login              authenticate credentials
POST   /auth/role               select active session role
POST   /auth/logout             end session

POST   /patients                register a patient  (Receptionist)
GET    /patients?q=             search by name or ID (Receptionist/Doctor scoped)
GET    /patients/:id/summary    patient summary      (Doctor, access-controlled)

POST   /queue                   add patient to today's queue (Receptionist)
GET    /queue                   today's queue, ordered (Receptionist/Doctor)
PATCH  /queue/:id               transition status

POST   /visits                  open a visit from a queue entry (Doctor)
PATCH  /visits/:id/finalize     save diagnosis/notes + medications, finalize (Doctor)
GET    /visits/:id/prescription printable prescription (Doctor)

GET    /pharmacy/patients/:id/plan  active medication plan (Pharmacy, valid Rx only)
POST   /pharmacy/dispensing         record a dispensing event (Pharmacy)

GET    /admin/dashboard         today's per-department counts, facility-scoped (Admin, no patient data)

POST   /admin/invites           invite a staff member (email, roles, department) (Admin)
GET    /admin/staff             list staff with department + roles (Admin)
POST   /admin/staff/:id         update a staff member's roles/department (Admin)
GET    /admin/facility          view facility profile (Admin)
POST   /admin/facility          update facility profile (Admin)

GET    /invite/:token           show the activation form for a valid invite (public)
POST   /invite/:token           activate: set name + password, create account (public)
```

Admin endpoints never return patient records or patient-identifying fields.

## User Flows

**Admin / HR flow**
1. Admin logs in → invites a staff member (email + roles + department) → an invitation email with a tokenized link is queued and sent.
2. Invitee opens the link → sets their name and password → account is created with the invited roles and department; the token is marked used.
3. Admin manages staff (change roles/department) and edits facility information; every change is audited.

**Patient-care vertical slice**
1. Receptionist logs in → registers a patient → core creates record (normalized email, encrypted PII) → notification service queues and sends a registration confirmation email.
2. Receptionist adds the patient to today's queue (status Waiting).
3. Doctor logs in with Doctor role → opens the queue → opens the patient summary (authorized because an active visit is created).
4. Doctor records diagnosis/notes, adds medications, finalizes → prescription generated and marked active → queue entry marked Completed → visit summary + prescription emails queued and sent → audit records appended.
5. Pharmacy logs in → looks up the patient → sees only the active medication plan → optionally records a dispensing event.
6. Admin dashboard shows today's **per-department** registered / in-queue / completed counts, scoped to the facility, with no patient-identifying data.

## Security Considerations

- **Authorization at the data layer.** Every read/write is gated by the core access control service; the UI gate is defense-in-depth, not the source of truth.
- **Patient isolation.** Queries are scoped so a response can never contain another patient's data. Doctor access to prior history requires a qualifying visit or a valid, unexpired AccessGrant.
- **Doctor-as-patient isolation.** A user's doctor role grants zero extra access to their own patient record; the two roles are evaluated independently.
- **Secrets.** Only from `.env`; nothing hardcoded. `.env.example` lists required variables.
- **Input validation** on every endpoint and form: reject with a clear message, never silently drop. Email validated by format + MX check where possible.
- **Encryption at rest** for PII; emails stored lowercase, phones E.164.
- **Audit trail** is immutable and written on every mutation.
- **Anti-spam:** every patient email carries an unsubscribe/opt-out link.

## Error Handling

- User-facing errors are non-technical and actionable; technical detail goes to server logs only.
- **Graceful email degradation:** if the provider is down, the triggering action (registration, finalize) still succeeds — the notification is queued as a `NotificationJob` and retried with backoff.
- **No silent data loss:** if a transport is unavailable, writes still persist through the core and replay to transports on recovery.
- **Conflict resolution:** last-write-wins per field, with the audit log preserving history.

## Testing Strategy

- **Core flow (integration):** register → queue → consult + prescribe → pharmacy view → admin dashboard, asserting emails are enqueued and counts are correct.
- **Auth/role:** valid/invalid login, multi-role selection, single-role auto-select, logout.
- **Access control (unit + integration):** patient isolation, doctor-history access gating (visit / grant / peer grant / expiry / revoke), doctor-as-patient isolation, pharmacy scope limits.
- **Email reliability:** triggering action succeeds when the provider is forced to fail; the job is queued and retried.
- **Validation:** missing fields and malformed email/phone are rejected with clear messages.
- All demo/test data is synthetic.

## Design Decisions & Tradeoffs

- **Server-rendered web over SPA** — better on poor connectivity and simpler for a single-command demo; tradeoff is less client interactivity, acceptable for the MVP.
- **SQLite locally, Postgres on deploy** — zero-setup local start while staying free-tier deployable; the ORM/query layer abstracts the difference.
- **Single notification service with a job queue** — centralizes templates, retries, and the unsubscribe requirement, and keeps triggering actions non-blocking; tradeoff is a small amount of extra indirection.
- **No SMS anything** — per steering, SMS is a future optional, patient-only transport; building stubs now would couple the core to an unbuilt module.
- **Strict module boundaries by directory** — keeps the core stable and features additive; tradeoff is a bit more boilerplate routing through core services instead of direct calls.
