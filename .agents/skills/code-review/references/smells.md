# Smell baseline

Judgement calls from Fowler's Refactoring (chapter 3). Each: what to look for, then the usual fix. A documented repo rule that endorses the pattern wins.

- Mysterious name: a name that doesn't say what the thing does or holds. Rename; if no honest name comes, the design is murky.
- Duplicated code: the same logic shape in more than one hunk or file. Extract it and call it from both.
- Feature envy: a function using another module's data more than its own. Move it to the data.
- Data clump: the same few fields or parameters travelling together. Make them one type.
- Primitive obsession: a string or number standing in for a domain concept. Give the concept its own type.
- Repeated switches: the same branching on the same type in several places. One map or one dispatch both sites share.
- Shotgun surgery: one logical change forcing scattered edits. Gather what changes together into one module.
- Divergent change: one module edited for several unrelated reasons. Split it so each changes for one reason.
- Speculative generality: abstraction, parameters or hooks for needs the acceptance criteria don't have. Delete it.
- Message chain: long `a.b().c().d()` navigation. Hide the walk behind one call on the first object.
- Middle man: a module that mostly delegates onward. Call the real target.
- Refused bequest: an implementer ignoring most of what it inherits. Compose instead of inheriting.
