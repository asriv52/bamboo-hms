# hackachusetts-healthcare-project

Hospital Management System for rural / low-resource clinics. Hackachusetts — Healthcare & Biotech track.

## Overview

A lightweight, modular Hospital Management System (HMS) for a single rural / low-resource
clinic. Staff log in and act in a role (Admin / Receptionist / Doctor / Pharmacy / Technician);
patients are records that receive email notifications and can view their own history through a
self-service portal.

The platform is **server-rendered** (Express + EJS), backed by **SQLite** locally, with a strict
**modular core**: a stable core layer owns entities, access control, notifications, and audit;
transport (web, email) and domain modules (queue, prescription, pharmacy, technician, portal,
attachments) depend on the core and never on each other. Email is the only patient-facing
notification channel — there is **no SMS** in this build.

## Installation

```bash
npm install
```

Copy `.env.example` to `.env` and adjust values if needed. The defaults run a full local demo
(SQLite file, console email provider that prints emails to the server log).

```bash
cp .env.example .env
```

## Running

Single command brings up the full stack with fresh synthetic seed data and demo logins:

```bash
npm run dev
```

Then open http://localhost:3000/login and sign in with a demo account (below), or open
http://localhost:3000/portal as a patient.

> With `EMAIL_PROVIDER=console` (the default), every email — including the patient portal's
> one-time access codes — is printed to the server log. Use `/notifications` in the app to see
> the queued/sent jobs.
>
> To **read** full emails in the browser instead, set `EMAIL_PROVIDER=mailbox`. Every outbound
> email is then captured into an in-memory **virtual mailbox** at `/mailbox`, grouped into a tab
> per recipient address, each showing the subject, plain text, and rendered HTML. It's a testing
> aid only: the store resets on restart and the `/mailbox` route is mounted **only when
> `NODE_ENV` is not `production`**, so PII-bearing emails are never reachable in a real deploy.

## Architecture

```
Transport modules   Web dashboard (EJS pages + routes) · Email sender (templates)
Domain modules      Queue · Prescription/Consultation · Pharmacy · Technician (lab) ·
                    Patient portal · Attachments
Core layer          Entities & records · Access control · Notification service (queue + retry) ·
                    OTP service · Local file store · Audit log · Encryption at rest
```

Rules enforced by directory boundaries: transport calls core/domain services (never the DB
directly); domain modules never import each other; all email flows through the single
notification service; every data read/write is authorized in the core access-control layer.

## Features

- **Staff login + role selection.** One account can hold multiple roles; the active role is
  chosen per session.
- **Patient registration, search, and daily queue** (Receptionist).
- **Consultation + prescription** (Doctor): diagnosis/notes, medications, **recommended lab
  tests**, and **file attachments**. Each visit gets a short **receipt access code** (e.g.
  `RCPT-7F3K9`).
- **Pharmacy** prescription lookup + dispensing.
- **Technician (lab):** look up a visit by its receipt code to see **only** its recommended
  tests (no diagnosis or notes), then upload results with an optional file.
- **Patient portal (account-level):** a patient enters their email, receives a 6-digit
  **email OTP**, and then sees **all** their past visits/receipts in one place — each expandable
  to diagnosis, notes, prescription, tests/results, and downloadable attachments.
- **Admin dashboard:** per-department daily counts only (no patient-identifying data).
- **File attachments:** stored on local disk under `uploads/` (gitignored). No cloud storage.

## Demo

All demo data is **synthetic** — no real patient information anywhere.

### Demo logins (password `demo1234`)

| Email | Role |
|---|---|
| `admin@clinic.test` | Admin (HR / facility) |
| `reception@clinic.test` | Receptionist |
| `doctor@clinic.test` | Doctor |
| `pharmacy@clinic.test` | Pharmacy |
| `technician@clinic.test` | Technician (lab) |
| `multi@clinic.test` | Doctor + Receptionist (demonstrates role selection) |

The seed also creates patient **Jordan Rivera** (`jordan.patient@example.test`) with **two past
visits/receipts**, so the account-level portal has history on first run. The seed prints Jordan's
two receipt codes and the portal instructions to the console.

### Vertical slice

1. **Receptionist** registers a patient → the patient gets a registration email → adds them to
   the day's queue.
2. **Doctor** opens the patient from the queue, records a visit, adds a prescription and
   recommended tests, optionally attaches a file, and finalizes → the patient gets a visit
   summary (and prescription) email. The visit shows its **receipt code**.
3. **Technician** opens `/technician`, enters the receipt code, sees the recommended tests only,
   and uploads a result (with an optional file).
4. **Pharmacy** looks up the active prescription and records dispensing.
5. **Patient** opens `/portal`, enters their email, gets an OTP (printed to the server log in
   demo mode), and views their **full visit history** — each receipt expandable to its details,
   results, and attachments.
6. **Admin** dashboard shows today's per-department counts (no patient data).

## Testing

```bash
npm test
```

Covers the core care flow, login/role selection, access-control rules (patient isolation,
doctor-as-patient isolation, pharmacy scope), the Technician lab flow, OTP issue/verify, the
account-level patient portal (including cross-patient isolation), attachments, and an
end-to-end web flow (register → consult with test + file → technician result → patient portal
login via email + OTP → sees all visits).

## Notes

- **Secrets** live only in `.env` (gitignored); nothing is hardcoded. See `.env.example`.
- **PII** is encrypted at rest; emails are normalized to lowercase, phones to E.164.
- **Graceful email degradation:** if the email provider is down, the triggering action still
  succeeds and the notification is queued and retried.
- **No SMS** anything in this build — SMS is a future, patient-only, optional transport module.
