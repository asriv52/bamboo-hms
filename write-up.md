# How We Used Kiro

**Project:** Bamboo HMS, a modular hospital management system for low-resource clinics
**Challenge track:** Healthcare & Biotech
**Kiro evidence in the repo:** `.kiro/steering/steering.md`, `.kiro/specs/hms/` (requirements, design, tasks), `personas.txt`, `progress.txt`

## Our approach

Kiro did the building, but we led the ideas. None of us is a healthcare professional, and we had no real patient data, so we treated Kiro's planning features as a way to bring in structure we didn't have:

1. **Learn the tools first.** Before writing any code, we learned how steering files and specs work in Kiro.
2. **Describe the problem.** We wrote the problem as rough bullet points: fragmented paper records, patients who move between clinics, and pharmacies that can't see a medication plan.
3. **Turn it into steering.** We cleaned the bullets into one focused prompt and had Kiro write it into `steering.md` as the project's goal, constraints and access rules.
4. **Write the spec in EARS notation.** Kiro turned the steering into `requirements.md`, `design.md` and `tasks.md`.
5. **Turn users into testers.** We wrote 9 user personas as role-based prompts, each with EARS test cases, and had Kiro test the app as each of them.

## Which Kiro tools did we use?

We used the **Kiro IDE** for the whole project. We didn't try the CLI, Web or Crew.

We used the IDE in two ways. A **Spec session** built the core of the system: registration, the queue, consultations, prescriptions, the pharmacy and the admin dashboard. Later features, such as WHOOP wearable data and the help-assistant chatbot, were built in **chat sessions** that rested on the same steering file, so Kiro already knew the access rules without being told again.

We also ran **a second Kiro instance as an in-the-loop reviewer.** It didn't write code. It logged and tracked what the coding instance built, checked that each feature was really finished, and kept the running log in `progress.txt`. That second instance is how we caught a merge that had been committed with unresolved conflict markers and no longer compiled.

**Working in parallel:** we kept the system modular (core layer, transport modules, domain modules) so each teammate could have their own Kiro build a separate feature. We then merged everything into one "master" Kiro workspace on one member's computer, which unified the code and fixed the integration problems.

## Spec-driven development

- **Structure:** `requirements.md` uses EARS notation ("WHEN a doctor finalizes a consultation, THEN the system SHALL…") for 9 requirements, from staff login through role-based access control. `design.md` defines the layered architecture and data model, and `tasks.md` breaks the work into steps Kiro carried out.
- **Personas tied to the spec:** each persona in `personas.txt` (Normal Patient, Emergency Patient, Family Patient, Financially Burdened Patient, Not Tech Savvy, Application Researcher, Security Specialist, Emergencies-at-Hospital Specialist, Doctor) has its own EARS test cases with IDs like `SS-01` and `TS-04`. The Security Specialist alone has 33 cases, written as if the system were national critical infrastructure.
- **How it helped:** the spec stood in for the healthcare expert and test data we didn't have. Each requirement says exactly who can do what and when, so Kiro had a clear definition of "done" and we had something concrete to test against.
- **Compared with vibe coding:** vibe coding was much more ambiguous. Casual natural language leaves gaps, and Kiro fills them with assumptions that can carry contextual and cultural bias. In a healthcare app, that can mean a wrong guess about who may see a patient's record. EARS statements remove that guessing.

## Agent hooks

We used hooks as **guardrails**, so that an autonomous agent couldn't damage the host machine:

- Kiro may only work inside the project directory.
- Web access is limited to searching and reading. Kiro may not download anything except libraries.
- Every new library must be approved by a human before it is installed.

This let us run Kiro in Autopilot mode with confidence. The riskiest actions, such as installing packages or touching files outside the project, always stopped for a human decision. The result is visible in `package.json`: the project uses only a small set of well-known dependencies. For example, the chatbot's word2vec model was written in about 220 lines of TypeScript instead of adding a machine-learning library.

## Steering docs

Steering was our single source of truth, so we never had to remind Kiro what the project was for. It saved a lot of time and stopped Kiro from losing track of the goal or inventing features we hadn't asked for.

**The strategy that made the biggest difference was writing the access rules into `steering.md`:** who may read what, enforced in the data layer and not just the UI. Examples include "receptionists never see clinical content," "a doctor sees a patient's history only after a visit or an access grant," and "technicians see only their own specialty."

Because those rules were always in context, Kiro checked every new feature against them before writing code. Some concrete results:

- The steering says every feature must be listed under a user class and mirrored in `FEATURE_MATRIX` in `src/core/accessControl.ts`. So when we added WHOOP data, Kiro added the new permissions, restricted them to doctors, and updated the steering itself.
- The rules made Kiro push back on unsafe designs. Our request for an "inverse hash" for wearable data became a sealed lookup table with its own encryption key, because a real hash can't be reversed and a reversible one would leak identity.
- The steering now tells future sessions that any new feature must also be added to the chatbot's knowledge base, which keeps the assistant from falling out of date.

## MCP

We didn't connect a custom MCP server. Instead we used Kiro's **built-in web search and page-fetch tools** to bring in outside knowledge during development:

- **WHOOP integration:** Kiro read the WHOOP Developer API v2 documentation and found that blood pressure isn't available through the public API. We therefore designed the pipeline so blood pressure stays empty for live WHOOP data, and added a simulator that fills it for the demo. The OAuth scopes were also chosen from the docs so the app never requests the patient's WHOOP name or email.
- **Help-assistant chatbot:** the last-minute chatbot reads the app's own features. It's built on established retrieval techniques (word2vec embeddings with SIF sentence weighting) and runs locally, with no LLM or external API, which suits clinics with poor internet.

## Property-based testing (PBT)

Our version of PBT was **persona-based testing**. Kiro tested the app while playing each persona, using that persona's role-based prompt and EARS test cases, alongside the 60 automated unit and integration tests (`npm test`). We didn't write property-based tests in the formal sense, with random inputs generated by a library.

The persona testing caught problems unit tests wouldn't have, because unit tests only check what we already thought to check:

- **Security Specialist:** found that the app had **no CSRF protection** on its forms (logged as item 2 in `update.txt`).
- **Financially Burdened Patient:** found that the **billing feature was incomplete**. The page existed but didn't load or submit anything (item 5 in `update.txt`).
- **Not Tech Savvy:** the biggest benefit. Its test cases (every task within 3 clicks, plain button labels, no dead ends) showed that a menu alone isn't enough for someone who doesn't know where to look. That led to the **help-assistant chatbot**. It answers only from features the user's own role is allowed to use, gives step-by-step directions, and logs questions it can't answer so the team can see which features are missing.

## Kiro powers

We didn't use any Kiro powers.

## What we learned

- **Steering is the most valuable feature.** Rules that apply to every response keep Kiro on track much better than repeating them in each prompt.
- **EARS specs and personas together** gave us test cases and expert review without access to real data or a healthcare professional.
- **A second Kiro instance as reviewer** catches what the building instance misses, especially after merges.
- **Guardrail hooks** are what make Autopilot mode safe to run on our own laptops.
