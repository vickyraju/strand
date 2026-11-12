# 0017 Components

Status: Implemented

## Context and Jira reference

Components are the parts of a project (API, Web, Billing). Each can have a lead, and says who new work in it goes to when nobody is chosen. An item can be in several components, and can name several affects versions: the releases a problem was found in.

Extended by spec 0304 (deleting a component can move its items to another) and spec 0309 (component names are unique in a project).

- **Jira DC:** a project's components have a name, a description, a component lead and a default assignee (Project default, Component lead, Project lead or Unassigned). An issue can have several components and several Affects Versions. The app follows Jira; "project default" isn't offered.

## Rules

- **R1: A project's components.** A project admin adds, changes and deletes them: a name (1 to 100 characters), a description (at most 2,000), a lead (optional) and a default assignee: nobody (the default), the component lead, or the project lead. They are listed by name, ignoring case. Each change is audited.
- **R2: An item's components and affects versions.** An item can be in several components and name several affects versions (at most 50 of each), all of its own project. Another project's are refused: 400 "Every component must be one of this project's", "Every release must be one of this project's".
- **R3: Default assignee.** New work created in components, with no assignee given, goes to the first of its components (in the item's order) whose default names someone: its lead, or the project lead. The server skips someone who can't work in the project. An assignee given, even nobody, wins. The web app does the same.
- **R4: Deleting a component** takes it off its items, as deleting a release takes it off their affects versions. (Moving them to another instead: spec 0304 R2.)
- **R5: Screens.** Project settings › Components lists them, with Add component (Name, Description, Component lead, "New work in it goes to"), edit and delete. An item's details show its components.

## Permissions

| Action | Viewer | Member | Project admin | System administrator |
|---|---|---|---|---|
| See components | ✓ | ✓ | ✓ | ✓ |
| Add, change or delete a component | – | – | ✓ | ✓ |
| Put an item in components (edit the item) | – | ✓ | ✓ | ✓ |

## Data model

`components (id, project_id, name, description, lead_id, default_assignee)`; `issues.component_ids uuid[]` and `issues.affects_release_ids uuid[]`, GIN-indexed: `server/migrations/20261106090000_components.sql`.

## API

- `GET /projects/:key`: `components`, by name.
- `POST /projects/:key/components`, `PATCH /projects/:key/components/:id`, `DELETE /projects/:key/components/:id`.
- Items: `componentIds` and `affectsReleaseIds` on create and `PATCH /issues/:key` (400 for another project's).

## Screens

As R5.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: components added with a lead and a default assignee, listed by name. Browser journey: an admin adds Billing with a lead |
| R2 | Server test: an item in two components and two affects versions; another project's refused |
| R3 | Server test: the component lead, then the project lead, an explicit choice wins, an outsider never. Browser journey: new work in Billing goes to its lead. Unit test (web): the same in the browser |
| R4 | Server test: removing a component or a release lets go of its items |
| R5 | Browser journey: Project settings › Components; the item shows its components |

## Out of scope and deliberate divergences

- **"Project default" as a default assignee:** not offered; a component either names someone or leaves new work unassigned.
