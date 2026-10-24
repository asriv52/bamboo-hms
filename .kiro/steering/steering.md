# Project Steering — Hackachusetts Healthcare Platform

## Vision

Build a modular healthcare information platform for low-resource, third-world environments where fragmented, paper-based records prevent coordinated care. The system unifies data across hospitals, doctors, patients, pharmacies, and ambulances so that every participant has synchronized, role-appropriate access to the information they need.

The primary interface is a **web application**. Notifications to patients are delivered by **email**. SMS support is a planned optional module for the future but is **not in scope for the current build** — do not build SMS infrastructure now.

The Hackachusetts demo targets a complete, working end-to-end flow. Prefer one polished vertical slice over many half-built modules.

---

## Problem Context

Rural and developing-world clinics suffer from fragmented, paper-based records. A patient visiting multiple facilities has no portable health history. Doctors lack visibility into prior diagnoses, current medications, or allergies. Pharmacies dispense without knowing a patient's full medication plan. Ambulances arrive without patient context. Administrators cannot see cross-facility load.

Email is the current communication channel for patient-facing notifications. SMS is an aspirational channel reserved for a future optional module.

---

## Core Entities

All entities are identified by at least one piece of **personally identifiable information (PII)**:

| Entity | Primary Identifier | Secondary Identifiers |
|---|---|---|
| Patient | Email address | Name, phone number, national ID, address |
| Doctor / Specialist | Email address | Name, phone number, license number, facility |
| Hospital / Clinic | Facility code | Name, address, phone, email |
| Pharmacy | Pharmacy code | Name, address, phone, email |
| Ambulance | Unit ID | Driver phone, region |
| Admin | Email address | Role, facility affiliation |

Phone numbers are stored as supplementary contact information and normalized to E.164 format (`+<country><number>`) when provided. They are **not** used as primary identifiers in the current build.

---

## Architecture Principle: Modular Information Core

The system is layered:

1. **Core layer** — Information storage and retrieval. Entities, records, and access control live here. Every module depends on this layer; it depends on nothing else.
2. **Transport modules** — How information travels: web dashboard, REST API, email notifications, SMS (future/optional — patient-facing only when built). Each module is optional and swappable.
3. **Domain modules** — What to do with information: prescription management, queue management, ambulance dispatch, pharmacy inventory, billing (future). Each module activates against the core layer.

New features are implemented as modules, not as changes to the core. The core must remain stable.

---

## Email Notification Design

Email is the current patient-facing notification channel. Staff (doctors, admins, pharmacies) are notified through the web dashboard; email notifications to staff are a stretch goal.

- All transactional emails must use a template system — no inline HTML strings in business logic.
- Email sending is handled by a single notification service in the core layer. No module sends email directly.
- Every email must include an unsubscribe/opt-out link and comply with basic anti-spam practices.
- If the email provider is unavailable, the notification is queued and retried — the triggering action (visit creation, prescription, etc.) must still succeed.
- Email addresses are validated on input (format check + DNS MX check where possible).
- Emails sent to patients must never include data belonging to another patient.

### Patient email triggers (MVP)
- Registration confirmation with login credentials.
- Visit summary after a doctor finalizes a consultation.
- Prescription issued — includes pharmacy lookup link.
- Medication restock reminder from pharmacy.

### SMS (future optional module — patient-facing only)
When SMS support is eventually added:
- It applies **only to patients**, not to doctors, admins, or pharmacies.
- The SMS module is a separate, optional transport module. It must not be required by any other module.
- Do not build any SMS parsing, gateway integration, or SMS-specific command routing in the current build. Leave no stubs that assume SMS exists.

---

## Access Control Rules

These rules are **non-negotiable** and must be enforced at the data layer, not just the UI layer.

### Patients
- Read: own health records, insurance data, doctor visit history, medication and complication history.
- Read: any hospital's public profile — specialties, available doctors, estimated costs, location, equipment, treatment modes.
- Cannot read: another patient's data. Cannot read internal hospital operational data.

### Doctors / Specialists
- Read/Write: clinical records for patients currently under their care (active visit exists at their facility).
- Read: a patient's prior visit summaries and medication history **only** when at least one of these conditions is met:
  1. The doctor has an existing past or active visit record with that patient.
  2. The patient has explicitly granted this doctor access (patient-issued authorization).
  3. One of the patient's other treating doctors has granted access on the patient's behalf (peer authorization).
- A doctor who is also registered as a patient accesses their **own** health records through the patient role only. Their doctor role grants no elevated access to their own record, and their patient record is subject to the same access rules as any other patient.
- Authorization grants (conditions 2 and 3 above) are stored as explicit access records in the core layer, are time-limited, and can be revoked by the patient at any time.
- Cannot access: financial or administrative hospital data. Cannot access records of patients not covered by any of the three conditions above.

### Hospitals / Admins
- Read/Write: records for patients who have had at least one visit at their facility. Access is scoped to a **visit identifier** — only data relevant to that visit's treatment context.
- Specialized health data (e.g., psychiatric records, HIV status) held by another facility: access requires a **formal inter-facility approval request**. The holding facility must approve before data is shared.
- Read: their own facility's statistics and operational data.
- Cannot access: data from visits at other facilities without the inter-facility approval flow.

### Pharmacies
- Read: a patient's **current active medication plan** and restock schedule — triggered only by a valid prescription or referral from a doctor.
- Write: dispensing records (what was sold, when, to whom).
- Read (public): which medications are available at which pharmacies, at what price, and from which supplier — this data is visible to patients and doctors as well.
- Cannot access: diagnoses, clinical notes, or any health data beyond what is needed to fulfill a prescription.

### Ambulance / Dispatch
- Read: patient's emergency contact, known critical allergies, and blood type — only when an active emergency dispatch is linked to that patient.
- Cannot access: full medical history without an active dispatch association.

---

## Data Synchronization Rules

- All writes go through the core layer and are immediately reflected for all authorized readers.
- If a transport module (SMS, web) is unavailable, writes must queue and replay when the transport recovers. No silent data loss.
- Conflict resolution: **last-write-wins per field**, with an audit log of all changes. Audit records are immutable.
- PII must be stored encrypted at rest. Email addresses used as identifiers must be stored in lowercase normalized form. Phone numbers, when present, must be normalized to E.164 format.

---

## Role-Based Identity

- A single email address can hold multiple roles (e.g., a doctor who is also a patient).
- Role context is resolved per-session via the active role selected at login. A user with multiple roles must explicitly select which role they are acting in for a given session.
- **Doctor-as-patient rule:** when a user holds both doctor and patient roles, their doctor role grants zero additional access to their own patient record. Both directions are isolated — their patient record is accessed only through the patient role, and their doctor role is limited to patients they have a qualifying relationship with (see Access Control Rules above).
- Roles are granted by an admin and stored in the core layer. Role elevation requires admin approval.

---

## Demo Flow (MVP)

The Hackachusetts demo must show this full vertical slice:

1. Receptionist (Admin role) registers a patient via the web UI. Patient receives a registration confirmation email.
2. Patient is added to the facility's queue.
3. Doctor pulls the patient summary from the web dashboard.
4. Doctor records a visit and writes a prescription via the web UI. Patient receives a visit summary email.
5. Pharmacy can view the active prescription for that patient.
6. Admin dashboard shows the day's activity (patients registered, in queue, visits completed).

All demo data must be **synthetic**. No real patient information is ever used.

---

## Non-Negotiable Constraints

- **Never hardcode secrets, credentials, or API keys.** All secrets live in `.env` (gitignored). See `.env.example` for required variables.
- **Input validation is mandatory** on every inbound path — API endpoint and web form. Reject with a clear error message; never silently drop input.
- **No real PII in version control, seed scripts, or demo data.** Use generated synthetic names, emails, and phone numbers.
- **Graceful degradation:** if the email provider is down, the triggering action (registration, visit creation, etc.) must still succeed. Queue the notification and retry.
- **No SMS infrastructure in this build.** Do not add SMS libraries, gateway clients, or SMS-parsing code. SMS is a future optional module.
- **Single-command local start:** `npm run dev` (or equivalent) must bring up the full stack with seed data and demo logins.
- **Free-tier deployable:** the production target must run on a free hosting tier (e.g., Railway, Render, Fly.io).

---

## Coding Conventions

- Separate concerns strictly: transport layer never calls the database directly — it calls the core service layer.
- Module boundaries are enforced by directory structure. A pharmacy module file must not import from a queue module file directly; both go through core services.
- Every new entity or module must have a corresponding seed entry in the demo data script.
- Error messages returned to users must be user-friendly (non-technical). Internal error details go to server logs only.
- All dates and times are stored in UTC. Display in local time is a transport-layer concern.

---

## References

- Spec requirements: `#[[file:.kiro/specs/hms/requirements.md]]`
- Spec design: `#[[file:.kiro/specs/hms/design.md]]`
- Environment config: `#[[file:.env.example]]`
