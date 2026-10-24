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
| Technician | Email address | Name, specialty, license number, facility |
| Hospital / Clinic | Facility code | Name, address, phone, email |
| Pharmacy | Pharmacy code | Name, address, phone, email |
| Ambulance | Unit ID | Driver phone, region |
| Admin | Email address | Role, facility affiliation |
| Receptionist | Email address | Name, facility, department |

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
- Registration confirmation with the patient ID (patients have no password; they sign in to the portal with email + one-time code).
- One-time access code (OTP) for patient-portal sign-in.
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

### Receptionists
- Read/Write: bed and room availability/status and equipment status, scoped to their facility.
- Read: visit assignment and location only — which doctor is seeing which patient, and at which bed/room/equipment — so arriving visitors can be directed correctly.
- Write: assign a patient + doctor to an available bed (records location/assignment only, never clinical content), and remove an occupant from a bed.
- Freeing a bed (setting it Available, or removing its occupant) detaches the patient and doctor from that bed so they disappear from the room, but the patient record remains in the database. Receptionists NEVER delete patient or staff records.
- Read: a building-wide distribution of patients across wards/rooms, so facility load is visible at a glance.
- Write: create a new patient record ONLY when no matching patient already exists in the system; otherwise check in the existing patient. Must not create duplicate patient records.
- Cannot read: any clinical content (diagnoses, notes, medications, lab results, EHR), billing, insurance, consent records, or staff HR data. The receptionist sees the *location and assignment* of a visit, never its medical content.
- Facility-scoped: a receptionist never sees beds, equipment, or visits belonging to another facility.

### Doctors / Specialists
- Read/Write: clinical records for patients currently under their care (active visit exists at their facility).
- Read: a patient's prior visit summaries and medication history **only** when at least one of these conditions is met:
  1. The doctor has an existing past or active visit record with that patient.
  2. The patient has explicitly granted this doctor access (patient-issued authorization).
  3. One of the patient's other treating doctors has granted access on the patient's behalf (peer authorization).
- Before any of those conditions exist, a doctor may see a patient's identity and allergies/blood type (but no history) **only** while the patient is waiting for care from them: in today's open queue at the doctor's facility, or holding a scheduled appointment with that doctor. Unrelated patients are invisible — not shown in search, not openable by ID.
- A doctor may open a new visit (which creates condition 1) only from today's open queue entry at their facility that no other doctor has taken, from an appointment with them scheduled for today, or as a follow-up for a patient they already qualify for. A doctor can never self-issue access by starting a visit on an arbitrary patient. Only the visit's own doctor can open its consultation screen.
- A doctor who is also registered as a patient accesses their **own** health records through the patient role only. Their doctor role grants no elevated access to their own record, and their patient record is subject to the same access rules as any other patient.
- Authorization grants (conditions 2 and 3 above) are stored as explicit access records in the core layer, are time-limited, and can be revoked by the patient at any time.
- Cannot access: financial or administrative hospital data. Cannot access records of patients not covered by any of the three conditions above.

### Hospitals (Admin and Receptionist roles)
The hospital class is split into two staff roles:

- **Admin** is an HR / facility-operations role. It invites and manages staff, maintains facility information, and manages operational data (rooms, equipment, staff schedules, accommodations). Admin sees **aggregate counts only** for patients and is denied every patient record and patient-identifying field at the data layer.
- **Receptionist** is the front desk. It registers patients, searches them, and manages the day's queue. It reads identifying/registration data (name, email, phone, insurance plan) for patients — never diagnoses, notes, EHR, or prescriptions.

Shared rules:
- Read: their own facility's statistics and operational data.
- Specialized health data (e.g., psychiatric records, HIV status) held by another facility: access requires a **formal inter-facility approval request**. The holding facility must approve before data is shared. *(Future module — not built yet.)*
- Cannot access: data from visits at other facilities without the inter-facility approval flow.

### Pharmacies
- Read: a patient's **current active medication plan** and restock schedule — triggered only by a valid prescription or referral from a doctor.
- Write: dispensing records (what was sold, when, to whom).
- Read (public): which medications are available at which pharmacies, at what price, and from which supplier — this data is visible to patients and doctors as well.
- Cannot access: diagnoses, clinical notes, or any health data beyond what is needed to fulfill a prescription.

### Technicians
- Read: patient EHR data **only for the technician's own specialty**. A specialty-scoped technician sees only records of that type for any patient they are assigned to.
  - Example: a bone (orthopedic) technician may read bone/orthopedic EHR data for all patients they serve and SHALL NEVER see cardiac, psychiatric, or any other EHR category.
  - A doctor with a qualifying relationship to the patient assigns the technician to that patient. The technician sees the patient's name only (for identification) — no contact details, diagnosis, or notes.
- Read/Write: lab tests for a visit at their facility, looked up by the visit's receipt code. Only the tests are shown — never the diagnosis, notes, or patient identity.
- Read: equipment status for their facility, limited to their specialty's equipment plus general equipment.
- Cannot access: EHR categories outside their specialty, billing, insurance, or administrative data.

### Ambulance / Dispatch *(future module — not built yet)*
- Read: patient's emergency contact, known critical allergies, and blood type — only when an active emergency dispatch is linked to that patient.
- Cannot access: full medical history without an active dispatch association.

---

## Application Requirements by User Class

This section is the authoritative feature/permission matrix. Every website view and
API endpoint must be scoped to the requesting user's class. A user class must never
be able to load a view or retrieve data that is not listed for its class below.
EHR access is further scoped by the Access Control Rules above (visit relationship,
authorization grants, and specialty scope for technicians).

### ALL users (shared baseline)
Every user class, regardless of role, has access to:
- **Help assistant** (chat button on every page, including signed-out visitors). It answers only from the knowledge base for the caller's own class (`src/modules/assistant/knowledgeBase.ts`), resolved from the server session, never from the client. It uses a locally trained word2vec retrieval index (no LLM). Questions it cannot answer for that class are logged, redacted, for Admin review. **When you add or change a feature, add or update its knowledge-base entry too.**
- Login with a unique ID. Staff sign in with email + password and pick an active role. Patients sign in to the patient portal (`/portal`) with their email + an emailed one-time code.
- Insurance marketplace information (plans, coverage options available in the market) — **every class except Doctor**. Doctors do not need market insurance data for clinical work.
- Location and operating hours of hospitals and pharmacies.

### Patient
- Past, present, and future visit information (own records only).
- Current medication plan: which medicine to take and when, when to refill, and where to obtain refills.
- Billing: what they currently owe and expected costs for given conditions/treatments.
- Electronic Health Record (EHR) for records belonging to them.
- Pharmacy prices, available medicines, and stock levels.
- Special accommodations: set their own accommodation needs and check which facilities support them.
- Appointment scheduler (book, view, reschedule, cancel own appointments).
- Current insurance information, coverage, and insurance billing.
- Access grants: give a doctor time-limited access to their history, and revoke it at any time.
- Visit receipts: each visit's receipt code, tests and results, and attachments.
- Wearable data (WHOOP, `/portal/wearables`): sign a versioned written consent (typed legal name, separate optional research opt-in), connect WHOOP, sync, view own recent data, and withdraw at any time. Withdrawing deletes the data and the re-identification key.

### Receptionist
The receptionist is a front-desk role focused on intake and visitor direction. Their
access is intentionally narrow — they are NOT a clinical or administrative role.
- Check in people who arrive at the facility.
- Register a person as a new patient ONLY when they have never been a patient in this
  system before. If a matching patient already exists, the receptionist checks them in
  rather than creating a duplicate record.
- Bed / room availability and status (view and update occupancy status).
- Equipment availability and status.
- Doctor cases / visits: which doctor is seeing which patient, and where. This lets the
  receptionist direct arriving visitors to the correct bed / room.
- Occupancy directory: which patient and which doctor are at which bed, room, or piece of
  equipment, so visitors can be pointed to the right place.
- Receptionists have NO access to: patient EHR / clinical history, billing, insurance,
  staff HR management, facility configuration, or consent records. They see visit
  *location and assignment* information only — not diagnoses, notes, medications, or
  test results.

### Hospital / Admin
- Staff availability (doctors, technicians, support staff schedules).
- Identifiable information for insurance plans, doctors, pharmacies, and technicians at their facility. **No patient-identifying data** (see Access Control Rules — patient identity is the Receptionist's scope).
- Accommodation availability at their facility.
- Equipment status (facility-ops view: category, location, operational state).
- Room and staff-shift management.
- Consent records between patients and doctors, shown **de-identified** (patient reference number, doctor, scope, status, expiry — no patient name or contact).
- Per-department daily activity counts (aggregate only).
- Staff invitations and management; facility profile.
- Help-assistant improvement log (`/admin/assistant-requests`): unanswered questions per user class, redacted of emails, phone numbers, codes, and long numbers.
- NOTE: Live bed occupancy (who is in which bed/room) is owned by the **Receptionist** role via the availability seat-map, not Admin. Admin manages staff, facility configuration, equipment inventory, rooms, and consent — not the live bed-occupancy board.

### Pharmacy
- Stock information and pricing.
- Patient purchase history (for patients they have dispensed to).
- Billing records for hospitals, patients, and insurance.
- Patient medication history, scoped to a valid prescription/referral per the Access Control Rules. In this build the valid prescription is the patient's active plan, looked up by its pharmacy token.

### Doctor
- Appointments with their past, present, and future patients.
- Patient EHR **only for patients under their care** (qualifying visit, patient authorization, or peer authorization per the Access Control Rules).
- Pharmacy stock levels.
- Medication history for their patients.
- Consultations: diagnosis, notes, prescriptions, recommended lab tests, attachments, and EHR entries by category.
- Peer authorization: grant another doctor time-limited access to a patient under their care. Assign a specialty technician to a patient.
- Wearable data (WHOOP) — **doctors only; no other staff class**:
  - Identified wearable data on the patient page, only for patients under their care AND with an active wearable consent.
  - The de-identified research (ML) dataset (`/research/wearables`): research opt-ins only, keyed by a random pseudonym, dates replaced by a per-subject day index, no names/emails/ids.
  - Re-identification of a research pseudonym: only to a patient already under their care, with a stated clinical reason; every attempt is audited, and unknown codes and unrelated patients get the same denial.
  - Storage rule: wearable measurements are stored only under the random pseudonym; the pseudonym → patient mapping lives in a vault sealed with a separate key (`WEARABLE_REID_KEY`).

### Technician
- Patient EHR limited strictly to the technician's own specialty (see Technicians under Access Control Rules). A bone specialist gets only bone EHR data and never any other category.
- Lab tests for a visit, looked up by receipt code (tests only).
- Equipment status.

### Enforcement notes
- The shared "ALL" baseline is additive; it never grants access to another class's restricted views.
- When a feature appears for multiple classes (e.g., equipment status for admins and technicians), each class still sees only the subset its role permits.
- Any new feature added in future iterations must be placed under the correct user class here before it is built, and must respect the Access Control Rules and the Security Specialist constraints in `personas.txt`.
- This matrix is mirrored in code as `FEATURE_MATRIX` in `src/core/accessControl.ts`. Staff services call `requireFeature()`; denials are audited. Patient-portal services are scoped by the portal session's patient id. Keep the two in sync.
- Costs shown before a service are labeled **estimates**; recorded charges are labeled **final**. Insurance coverage % splits each charge into insurer and patient portions.
- All times are stored and entered in UTC in this build (appointments, shifts). Local-time display is a future transport concern.

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

1. Receptionist registers a patient via the web UI. Patient receives a registration confirmation email.
2. Patient is added to the facility's queue.
3. Doctor pulls the patient summary from the web dashboard.
4. Doctor records a visit and writes a prescription via the web UI. Patient receives a visit summary email.
5. Pharmacy can view the active prescription for that patient.
6. Admin dashboard shows the day's activity per department (patients registered, in queue, visits completed) as aggregate counts only.
7. Patient signs in to the portal with email + one-time code and sees their visits, medication plan, appointments, bills, and EHR.

---

## Current Stack

- Node.js + TypeScript, Express, EJS server-rendered views, SQLite (`better-sqlite3`). Tests use Vitest + Supertest against an in-memory database.
- `npm run dev` re-seeds synthetic data and starts the server. `npm test` runs the suite.
- Schema lives in `src/core/db.ts`. New columns on existing tables are added through the `ensureColumn` migration helper so existing `hms.db` files keep working.

All demo data must be **synthetic**. No real patient information is ever used.

---

## Non-Negotiable Constraints

- **Never hardcode secrets, credentials, or API keys.** All secrets live in `.env` (gitignored). See `.env.example` for required variables.
- **Input validation is mandatory** on every inbound path — API endpoint and web form. Reject with a clear error message; never silently drop input.
- **No real PII in version control, seed scripts, or demo data.** Use generated synthetic names, emails, and phone numbers.
- **Graceful degradation:** if the email provider is down, the triggering action (registration, visit creation, etc.) must still succeed. Queue the notification and retry.
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
