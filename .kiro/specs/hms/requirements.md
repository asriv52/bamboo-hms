# Requirements Document

## Introduction

A lightweight **Hospital Management System (HMS)** for **rural / low-resource hospitals** that currently rely on paper and lack proper digital systems. Design goal: simple enough for non-technical staff, runs on modest hardware and poor connectivity.

For the Hackachusetts hackathon, the aim is a **complete, working end-to-end demo** over many half-built modules.

### Core demo flow

> Receptionist registers a patient → adds them to the day's queue → doctor pulls up the patient and records a visit → doctor writes a prescription → admin sees the day's activity.

### Assumptions (to revisit)

- Staff log in (Admin / Receptionist / Doctor); patients are records, not accounts.
- Synthetic data only — no real patient information.
- Single clinic, English UI, web app.

---

## Requirements

### Requirement 1: Staff Login

**User Story:** As a staff member, I want to log in, so that I can access the system with the right permissions.

#### Acceptance Criteria

1. WHEN a user submits valid credentials, THEN the system SHALL log them in and show their dashboard.
2. WHEN a user submits invalid credentials, THEN the system SHALL reject the login with an error message.
3. WHEN a user logs out, THEN the system SHALL end the session.

### Requirement 2: Patient Registration & Lookup

**User Story:** As a receptionist, I want to register and find patients, so that records are kept and reused.

#### Acceptance Criteria

1. WHEN a receptionist submits a new patient's details, THEN the system SHALL create a patient record with a unique ID.
2. WHEN required fields are missing, THEN the system SHALL reject the submission with a validation message.
3. WHEN a receptionist searches by name or ID, THEN the system SHALL return matching patients.

### Requirement 3: Daily Patient Queue

**User Story:** As a receptionist, I want to add patients to the day's queue, so that doctors see them in order.

#### Acceptance Criteria

1. WHEN a receptionist adds a patient to the queue, THEN the system SHALL create an entry with status "Waiting."
2. WHEN a doctor completes a consultation, THEN the system SHALL mark the entry "Completed."

### Requirement 4: Consultation & Prescription

**User Story:** As a doctor, I want to record a visit and write a prescription, so that care is documented.

#### Acceptance Criteria

1. WHEN a doctor saves a visit (diagnosis and notes), THEN the system SHALL store it linked to the patient.
2. WHEN a doctor adds medications and finalizes, THEN the system SHALL produce a printable prescription.
3. WHEN a patient record is viewed, THEN the system SHALL show their past visits.

### Requirement 5: Admin Dashboard

**User Story:** As an admin, I want an overview of activity, so that I can see the clinic's daily load.

#### Acceptance Criteria

1. WHEN an admin opens the dashboard, THEN the system SHALL show today's patients registered, in queue, and visits completed.

---

## Non-Functional (keep in mind, detail later)

- **Testing:** automated tests for the core flow and login.
- **Error handling:** clear validation messages; graceful failures, no lost data.
- **Deployment:** runs locally with one documented command; seed script with demo data and logins; deployable to a free host.

---

## To Fill In Later

- Detailed roles/permissions, offline behavior, security specifics.
- Stretch modules: pharmacy/inventory, billing, lab orders, reminders, localization, analytics.
