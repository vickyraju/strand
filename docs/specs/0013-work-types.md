# 0013 Work types

Status: Implemented

## Context and Jira reference

Work types are Jira's issue types: what kind of work an item is. Each project has its own list. The built-in types can be renamed and recoloured but not removed; a project admin can add more, and each type can follow its own workflow through the project's workflow scheme (spec 0010 R5).

Extended by spec 0310 (a template's starting types), spec 0303 (levels: epics and sub-items), spec 0803 (initiatives) and spec 0503 (fields by work type).

- **Jira DC:** issue types are global, grouped per project by an issue type scheme; an administrator adds, renames and deletes them, and deleting one in use asks which type its issues change to. The workflow scheme maps each issue type to a workflow. The app keeps the list per project instead of in a scheme.

## Rules

- **R1: The built-in types.** A project has Epic, Story, Task and Bug (keys `epic`, `story`, `task`, `bug`; Task is the default for new work). A project admin renames or recolours them for that project only. They can't be removed: 409 "Bug is built in: rename it instead".
- **R2: Adding a type.** A project admin adds a type with a name (1 to 40 characters), a colour and one of 17 icons. It gets a key of its own, `t-` and 10 letters or digits. Names are unique in the project, ignoring case: 409 "A work type with that name already exists", when adding or renaming. Members get 403. Adding, changing and removing are audited.
- **R3: Items have the project's types.** Creating or changing an item to a type the project doesn't have is refused: 400 "That work type isn’t in this project". Exports show the type's name, not its key.
- **R4: A workflow per type.** Each type follows the workflow its project's scheme gives it (spec 0010 R5): only its transitions are offered to, and move, items of that type. Adding or removing a type applies the scheme to the project again. The web app offers and allows the same.
- **R5: Removing an added type.**
  - When items are of that type, a type to move them to is needed: 409 "n work items are of this type: choose a type to move them to" without one; 400 "Choose another work type of this project" for itself or an unknown type.
  - Its items change to the chosen type, and each item's history records it (field `type`).
  - Its templates change to the chosen type, or to Task.
  - Transitions that only that type used leave the project.
- **R6: Screens.** Project settings › Work types lists the types with their icons. Add work type asks for the name and icon; Remove asks which type its items change to. An item shows its type's icon, labelled with the type's name.

## Permissions

| Action | Viewer | Member | Project admin | System administrator |
|---|---|---|---|---|
| See the project's types | ✓ | ✓ | ✓ | ✓ |
| Add, rename, recolour or remove a type | – | – | ✓ | ✓ |

## Data model

`work_types (project_id, key, name, color, icon, position)`, seeded with the four for every project; `transitions.type_keys` (null: every type); `issues.type` and `item_templates.type` hold a key: `server/migrations/20261103090000_work_types.sql`.

## API

- `GET /projects/:key`: `types`.
- `POST /projects/:key/types` (201; 409 name taken), `PATCH /projects/:key/types/:typeKey`, `DELETE /projects/:key/types/:typeKey?moveTo=` (409 built in or in use without `moveTo`; 400 bad `moveTo`).

## Screens

As R6.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: the built-in four, renamed per project, can't be removed |
| R2 | Server test: an added type gets a `t-` key; a duplicate name is refused; members can't. Browser journey: an admin adds Incident in settings |
| R3 | Server test: an unknown type refused on create and edit; the CSV export shows the name |
| R4 | Server test: incidents go To do → Done, tasks can't. Browser journey: only Incident items are offered Done. Unit test (web): a transition limited to some types |
| R5 | Server test: removing a type in use needs `moveTo`; its items move, with history; its transitions go |
| R6 | Browser journey: Add work type in Project settings; the item shows its type |

## Out of scope and deliberate divergences

- **Issue type schemes:** each project keeps its own list; there is no shared scheme of types.
- **Sub-task types:** levels are spec 0303.
