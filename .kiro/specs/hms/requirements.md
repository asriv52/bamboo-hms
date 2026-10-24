# Requirements Document

## Introduction

A lightweight **Hospital Management System (HMS)** for **rural / low-resource hospitals** that currently rely on paper and lack proper digital systems. The platform unifies patient data so staff have synchronized, role-appropriate access to the information they need. Design goal: simple enough for non-technical staff, runs on modest hardware and poor connectivity.

The primary interface is a **web application**. Patient-facing notifications are delivered by **email**. SMS is a planned future optional module and is **explicitly out of scope** for this build.

For the Hackachusetts hackathon, the aim is a **complete, working end-to-end demo** (one polished vertical slice) over many half-built modules.

### Core demo flow

> Admin invites staff and assigns them to departments → Receptionist registers a patient → patient receives a registration confirmation email → receptionist adds them to the day's queue → doctor pulls up the patient summary → doctor records a visit and writes a prescription → patient receives a visit summary email → pharmacy can view the active prescription → admin sees the day's activity as per-department counts (no patient info).

### Assumptions

- Staff log in and select an active role (Admin / Receptionist / Doctor / Pharmacy). A single account may hold multiple roles; the acting role is chosen per session at login.
- Admin is a facility-administration / HR role: it invites and manages staff, assigns them to departments and roles, and maintains hospital information. Admin does **not** register patients and does **not** see patient-level data.
- Staff belong to a **department** within the facility. Patient registration and queueing are performed by Receptionists; Admins only see aggregate counts per department.
- Patients are records, not interactive accounts, in this build. Patients receive information by email only.
- Synthetic data only — no real patient information anywhere (version control, seed scripts, or demo data).
- Single clinic, English UI, web app.
- All writes go through the core service layer; transport (web, email) never touches the database directly.

---

## Requirements

### Requirement 1: Staff Login & Role Selection

**User Story:** As a staff member, I want to log in and act in a specific role, so that I access the system with exactly the permissions that role allows.

#### Acceptance Criteria

1. WHEN a user submits valid credentials, THEN the system SHALL authenticate them and establish a session.
2. WHEN an authenticated user holds more than one role, THEN the system SHALL require them to select an active role for the session before granting access.
3. WHEN an authenticated user holds exactly one role, THEN the system SHALL set that role as the active session role automatically.
4. WHEN a user submits invalid credentials, THEN the system SHALL reject the login with a user-friendly error message and SHALL NOT reveal whether the email or the password was wrong.
5. WHEN a user logs out, THEN the system SHALL end the session and clear the active role.
6. WHEN a session is active, THEN every request SHALL be authorized against the active role at the data layer, not only in the UI.

### Requirement 2: Patient Registration & Lookup

**User Story:** As a receptionist, I want to register and find patients, so that records are kept and reused across visits.

#### Acceptance Criteria

1. WHEN a receptionist submits a new patient's details, THEN the system SHALL create a patient record with a unique ID and a normalized, lowercased email address as the primary identifier.
2. WHEN a phone number is provided, THEN the system SHALL normalize it to E.164 format before storing it.
3. WHEN required fields are missing or the email format / MX check fails, THEN the system SHALL reject the submission with a clear validation message and SHALL NOT silently drop input.
4. WHEN a patient is successfully registered, THEN the system SHALL send a registration confirmation email containing login/lookup information and an unsubscribe link.
5. IF the email provider is unavailable, THEN the system SHALL still create the patient record, queue the notification, and retry later (no lost data, no failed registration).
6. WHEN a receptionist searches by name or patient ID, THEN the system SHALL return matching patients.
7. WHEN patient PII is stored, THEN the system SHALL store it encrypted at rest.
8. WHEN a user whose active role is Admin attempts to register, search, or view a patient, THEN the system SHALL deny the action at the data layer. Only Receptionists register patients.

### Requirement 3: Daily Patient Queue

**User Story:** As a receptionist, I want to add patients to the day's queue, so that doctors see them in order.

#### Acceptance Criteria

1. WHEN a receptionist adds a registered patient to the queue, THEN the system SHALL create a queue entry with status "Waiting" and a timestamp (stored in UTC).
2. WHEN a doctor begins a consultation, THEN the system SHALL allow the entry to move to status "In Progress."
3. WHEN a doctor completes a consultation, THEN the system SHALL mark the entry "Completed."
4. WHEN the queue is displayed, THEN the system SHALL order entries by their waiting time and scope them to the current day.

### Requirement 4: Consultation & Prescription

**User Story:** As a doctor, I want to record a visit and write a prescription, so that care is documented and the patient is informed.

#### Acceptance Criteria

1. WHEN a doctor opens a patient from the queue, THEN the system SHALL create (or reference) an active visit, which grants that doctor read/write access to the patient's clinical record for that visit.
2. WHEN a doctor views a patient summary, THEN the system SHALL show prior visit summaries and medication history ONLY if the doctor has a past or active visit with that patient, OR the patient has granted access, OR a treating peer doctor has granted access on the patient's behalf.
3. WHEN a doctor saves a visit (diagnosis and notes), THEN the system SHALL store it linked to the patient and the active visit identifier.
4. WHEN a doctor adds medications and finalizes the consultation, THEN the system SHALL produce a printable prescription AND mark it as the patient's active medication plan.
5. WHEN a consultation is finalized, THEN the system SHALL send the patient a visit summary email and a prescription-issued email containing a pharmacy lookup link.
6. WHEN a visit is finalized, THEN the system SHALL mark the corresponding queue entry "Completed."
7. WHEN any clinical record is written, THEN the system SHALL append an immutable audit record capturing who changed what and when.

### Requirement 5: Pharmacy Prescription Access

**User Story:** As a pharmacy, I want to view a patient's active medication plan, so that I can dispense against a valid prescription.

#### Acceptance Criteria

1. WHEN a pharmacy looks up a patient with a valid, active prescription, THEN the system SHALL return the active medication plan and restock schedule only.
2. WHEN a pharmacy records a dispensing event, THEN the system SHALL store a dispensing record (what, when, to whom).
3. WHEN a pharmacy attempts to access diagnoses, clinical notes, or any data beyond the active prescription, THEN the system SHALL deny access at the data layer.

### Requirement 6: Admin Dashboard (Per-Department Counts)

**User Story:** As an admin, I want an aggregate overview of the clinic's daily load broken down by department, so that I can manage staffing without seeing any patient information.

#### Acceptance Criteria

1. WHEN an admin opens the dashboard, THEN the system SHALL show today's counts broken down **per department**: patients registered, patients in queue, and visits completed.
2. WHEN the dashboard is displayed, THEN the system SHALL scope all statistics to the admin's own facility.
3. WHEN the dashboard is displayed, THEN it SHALL contain only aggregate numbers and department labels. It SHALL NOT contain any patient name, email, ID, or other patient-identifying data.

### Requirement 7: Staff Invitation & Management (Admin / HR)

**User Story:** As an admin, I want to invite staff by email and assign them to departments and roles, so that the right people have the right access without me handling their passwords or registering patients myself.

#### Acceptance Criteria

1. WHEN an admin submits an invite with an email, one or more roles, and a department, THEN the system SHALL create a pending staff invitation with a unique, single-use, time-limited token and SHALL NOT create an active account yet.
2. WHEN an invitation is created, THEN the system SHALL send an invitation email containing a tokenized activation link and an unsubscribe link.
3. WHEN an invitee opens a valid, unexpired, unused token and submits their name and a password, THEN the system SHALL create their staff account with the invited roles and department and mark the token used.
4. WHEN a token is expired, already used, or unknown, THEN the system SHALL reject activation with a user-friendly error and SHALL NOT create an account.
5. WHEN an admin views staff, THEN the system SHALL list staff at the admin's facility with their department and roles; the list SHALL NOT include any patient data.
6. WHEN an admin changes a staff member's roles or department, THEN the system SHALL update the account and append an immutable audit record of the change.
7. WHEN a user whose active role is not Admin attempts any staff-invite or staff-management action, THEN the system SHALL deny it at the data layer.

### Requirement 8: Hospital / Facility Information (Admin)

**User Story:** As an admin, I want to maintain my facility's information, so that staff and the public profile reflect accurate hospital details.

#### Acceptance Criteria

1. WHEN an admin views facility information, THEN the system SHALL show the facility's editable profile (name, address, phone, departments, specialties).
2. WHEN an admin updates facility information with valid input, THEN the system SHALL save it and append an immutable audit record.
3. WHEN an admin submits invalid facility input, THEN the system SHALL reject it with a clear validation message.
4. WHEN a user whose active role is not Admin attempts to edit facility information, THEN the system SHALL deny it at the data layer.

### Requirement 9: Role-Based Access Control (Cross-Cutting)

**User Story:** As the system owner, I want access enforced by role at the data layer, so that no participant can read another participant's data.

#### Acceptance Criteria

1. WHEN any entity requests data, THEN the system SHALL enforce the role's read/write scope in the core layer regardless of which UI or endpoint made the request.
2. WHEN a patient's data is requested, THEN the system SHALL never return data belonging to a different patient.
3. WHEN a user holds both doctor and patient roles, THEN the doctor role SHALL grant zero additional access to that same user's own patient record.
4. WHEN access is granted via patient authorization or peer-doctor authorization, THEN the grant SHALL be stored as an explicit, time-limited access record that the patient can revoke at any time.
5. WHEN any authorization decision is made, THEN a denied request SHALL return a user-friendly error without leaking the existence or contents of protected data.
6. WHEN the active role is Admin, THEN the system SHALL permit staff and facility administration but SHALL deny all access to patient records and patient-identifying data.

---

## Non-Functional Requirements

- **Modular architecture:** a stable core layer (entities, records, access control) with swappable transport modules (web, email) and domain modules (queue, prescription, pharmacy). New features are modules, not core changes. Modules communicate only through core services.
- **Testing:** automated tests for the core demo flow, login/role selection, and access-control rules.
- **Error handling:** clear, non-technical validation messages to users; internal details to server logs only; graceful failures with no lost data.
- **Email reliability:** all transactional email uses a template system; a single core notification service sends all email; every email includes an unsubscribe link; failed sends are queued and retried without blocking the triggering action.
- **Security:** no hardcoded secrets (all in gitignored `.env`); mandatory input validation on every inbound path; PII encrypted at rest; emails normalized to lowercase, phones to E.164.
- **Data:** all timestamps stored in UTC; conflict resolution is last-write-wins per field with an immutable audit log.
- **Deployment:** single-command local start (`npm run dev` or equivalent) brings up the full stack with seed data and demo logins; deployable to a free hosting tier (Railway / Render / Fly.io).

---

## Explicitly Out of Scope (This Build)

- **SMS** — no SMS libraries, gateways, parsing, or stubs. SMS is a future, patient-only, optional transport module.
- Patient self-service accounts, ambulance dispatch, inter-facility approval flows, insurance/billing, lab orders, and analytics beyond the daily dashboard. These remain future modules that the core layer should not be redesigned around, but need not be implemented now.
