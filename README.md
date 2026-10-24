# Bamboo HMS

**One health record that follows the patient across every clinic, pharmacy, and lab.**

Hackachusetts 2026 · **Healthcare & Biotech** track · Built with [Kiro](https://kiro.dev)

---

## The problem

In low-resource clinics, patient records live on paper. A patient who visits two facilities has
no portable history, so doctors treat without knowing prior diagnoses, allergies, or current
medications. Pharmacies dispense without seeing the full plan. Front desks can't see which beds
are free. Patients can't see their own records at all.

## What Bamboo HMS does

Bamboo HMS is a lightweight, modular hospital management system. It unifies records across
patients, doctors, receptionists, pharmacies, technicians, and admins, and gives each one
**exactly** the slice of data their role needs. Access is enforced at the data layer, not just
hidden in the UI.

It's built to be simple to run where resources are thin: a single Node process, a SQLite file,
server-rendered pages that work on slow connections, email for notifications, and an SMS
channel for patients without smartphones.

## Features by user

### Patient (portal at `/portal`, no password)
- Sign in with **email + one-time code**.
- Full **visit history** with receipt codes, diagnoses, prescriptions, lab results, and attachments.
- **Medication plan:** what to take and when, refill dates, and which pharmacies stock it (with prices).
- **Appointments:** book, reschedule, and cancel.
- **Billing:** what's owed, with each charge split into insurer and patient share. Estimates and final charges are labeled separately.
- **Electronic health record** by category.
- **Access grants:** give a specific doctor time-limited access to your history and revoke it at any time.
- **Accommodations:** set needs (e.g. wheelchair access, translator) and see which facilities support them.
- **Wearables (WHOOP):** sign a versioned consent, connect a device (real OAuth or simulated), and optionally opt in to research.

### Receptionist
- Register new patients (a second record with the same email is rejected, so existing patients are found and checked in instead) and manage today's queue.
- **Bed seat-map:** wards → rooms → beds, color-coded by status, with who is in each bed and which doctor is treating them, so visitors can be directed. Location only, never clinical content.
- Assign and release beds, update equipment status, and see building-wide patient distribution.

### Doctor
- Open visits only from the queue, today's appointments, or existing care relationships. Unrelated patients are invisible.
- Consultations: diagnosis, notes, prescriptions, recommended lab tests, attachments, and categorized EHR entries.
- **Peer grants** to another doctor, and assigning a specialty technician to a patient.
- Wearable trends for patients under their care, plus a **de-identified research dataset** (CSV export). Re-identifying a pseudonym requires an existing care relationship and a stated reason, and is audited.
- Appointments, "my patients", and pharmacy stock.

### Pharmacy
- Look up the active prescription by its token and record dispensing.
- Stock and pricing, purchase history, and billing (patients, hospitals, insurers).

### Technician
- Look up a visit's lab tests by receipt code and upload results. Never sees diagnosis, notes, or identity.
- **Specialty-scoped EHR:** an orthopedic technician sees only orthopedic records, never cardiac or psychiatric ones.
- Equipment for their specialty plus general equipment.

### Admin (HR / facility operations)
- Staff invites and management, schedules, rooms, equipment, accommodation capacity, and facility profile.
- Consent records shown **de-identified**, and per-department daily activity as **aggregate counts only**. Admins are denied every patient record.
- A review page of help-assistant questions nobody could answer, to plan improvements.

### Everyone
- Public directory of hospitals and pharmacies with hours and locations; insurance marketplace (all roles except Doctor).
- **Help assistant:** an in-app chat widget that answers "how do I…" questions, scoped to the user's role. It runs fully offline using a small word2vec model trained locally on the app's own knowledge base, with no LLM and no network calls. Emails, phone numbers, and codes are stripped before unanswered questions are stored.

### SMS channel (patients only)
A standalone SMS simulator shows how a patient with a basic phone can text the clinic. Commands
include `EHR`, `REC <no.>`, `MEDS`, `PHARMACY`, `HOSPITAL`, `APPT`, and `HELP`. It's read-only and
resolves the patient from their phone number. Nothing else in the app depends on it.

## Privacy and security

- PII encrypted at rest; emails normalized to lowercase and phones to E.164.
- Role-based **feature matrix** (`FEATURE_MATRIX` in `src/core/accessControl.ts`) checked by every staff service; denials are audited.
- Doctor-as-patient isolation: holding a doctor role gives no extra access to your own record.
- Wearable data is stored under random pseudonyms with a separate re-identification key. Withdrawing consent deletes the data, the connection, and the vault entry.
- Audit log of writes, access denials, and wearable re-identification.
- If email delivery fails, the triggering action still succeeds and the notification is queued and retried.
- Secrets live only in `.env` (gitignored). All demo data is **synthetic**.

---

## Quick start

Requires Node.js (tested on v24) and npm.

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` re-seeds synthetic data and starts the app at **http://localhost:3000**. The seed
output lists every demo login, Jordan's receipt codes, and the pharmacy lookup token.

### Demo logins (password `demo1234`)

| Email | Role |
|---|---|
| `reception@clinic.test` | Receptionist |
| `doctor@clinic.test` | Doctor (General Medicine) |
| `doctor2@clinic.test` | Doctor (Orthopedics) |
| `pharmacy@clinic.test` | Pharmacy |
| `technician@clinic.test` | Technician (Laboratory) |
| `bonetech@clinic.test` | Technician (Orthopedic) |
| `admin@clinic.test` | Admin |
| `multi@clinic.test` | Doctor + Receptionist (shows role selection) |

**Patient portal:** open `/portal`, enter `jordan.patient@example.test`, and use the one-time code.
With `EMAIL_PROVIDER=mailbox` (the `.env.example` default) the code and every other email appear
at **`/mailbox`**, one tab per recipient. With `EMAIL_PROVIDER=console` they print to the server log.
`/mailbox` is only mounted outside production.

### SMS simulator

```bash
npm run sms
```

Opens a phone-style chat UI at **http://localhost:3100** (`SMS_PORT` to change). Pick a patient's
number and text `HELP`.

### Other scripts

| Command | What it does |
|---|---|
| `npm test` | Runs the test suite (Vitest + Supertest, in-memory DB) |
| `npm run seed` | Re-seeds synthetic data without starting the server |
| `npm run rag:build` | Retrains the help assistant's word vectors and rebuilds its index |
| `npm run build` / `npm start` | Compile to `dist/` and run the production build |

### Configuration

See `.env.example`. Key variables: `SESSION_SECRET`, `PII_ENCRYPTION_KEY`, `WEARABLE_REID_KEY`
(must differ from the PII key), `EMAIL_PROVIDER` (`console` / `mailbox` / `smtp` plus `SMTP_*`),
`PUBLIC_BASE_URL`, and optional `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET`. Leave the WHOOP values
empty to use simulated wearable data.

## Demo walkthrough

1. **Receptionist** registers a patient (registration email sent) and adds them to the queue, then assigns a bed on the seat-map at `/availability`.
2. **Doctor** opens the patient from the queue, records diagnosis and notes, prescribes, orders lab tests, attaches a file, and finalizes. The patient gets visit-summary and prescription emails, and the visit gets a receipt code.
3. **Technician** enters the receipt code at `/technician` and uploads a result.
4. **Pharmacy** looks up the prescription token and records dispensing.
5. **Patient** signs in at `/portal` and sees visits, medication plan, bills, appointments, and EHR. They grant `doctor2` access and connect a simulated WHOOP.
6. **Doctor** views wearable trends on the patient page and the de-identified research dataset at `/research/wearables`.
7. **Admin** sees per-department counts with no patient data.
8. **SMS:** the same patient texts `MEDS` from the simulator.

## Architecture

```
Transport   Web (Express + EJS) · Email (templates, console/mailbox/SMTP) · SMS simulator
Domain      Queue · Consultation/Prescription · Pharmacy · Technician · Portal · Appointments ·
            Billing · EHR · Grants · Availability (beds) · Facility ops · Directory ·
            Wearables (WHOOP) · Help assistant · Attachments · Admin
Core        Entity stores · Access control + feature matrix · Notification queue + retry ·
            OTP · Encryption · Audit log · File store · SQLite schema + migrations
```

- Transport calls domain/core services and never touches the database directly.
- Domain modules don't import each other; they share data through the core.
- All email goes through the single notification service and named templates.
- Schema lives in `src/core/db.ts`; new columns are added with `ensureColumn` so existing databases keep working.

Stack: Node.js, TypeScript, Express, EJS, SQLite (`better-sqlite3`), Vitest, Supertest.

## Testing

```bash
npm test
```

60 tests across 8 files cover the core care flow, role selection, access-control isolation
(patient ↔ patient, doctor-as-patient, admin, pharmacy, technician specialty scope), the
technician lab flow, OTP sign-in, the patient portal, bed occupancy and facility scoping, the
virtual mailbox, the SMS commands, and an end-to-end web flow.

## How we used Kiro

The `.kiro/` directory is part of the submission and is intentionally not gitignored.

- **Spec-driven development:** `.kiro/specs/hms/` contains the requirements, design, and task plan Kiro implemented the core system from.
- **Steering:** `.kiro/steering/steering.md` defines the product vision, the per-role access-control rules, the feature matrix, and coding conventions. Kiro followed it for every change, and it is mirrored in code as `FEATURE_MATRIX`.
- **Agentic workflows:** Kiro resolved several broken merges (conflict markers committed into the core data layer), unified two competing equipment designs, and verified each fix with the TypeScript compiler and the test suite before restarting the app.



