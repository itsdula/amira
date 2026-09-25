# TICKET-0012: desk shows an error when the store is empty

- status: fixed
- severity: polish
- surface: dashboard
- filed: 2026-09-23 (Dula)

## What I saw

After the store was wiped, the desk had nothing to show and the thread still read like something was wrong.

## What I expected

An empty state. No error when there are simply no leads or messages.

## Agent notes

- Root cause: with zero leads the thread said “Pick a lead.” A wiped selection id also stayed selected, so the pane never settled on the empty store.
- Component: `desk/src/App.tsx`
- Fix: empty state for no leads and for a lead with no messages. Drop a selected id that is no longer in the list. Not committed.
