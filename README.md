# Arbox booker — phone app

A single static page for booking classes at CrossFit White City on
[Arbox](https://arboxapp.com). Open it, sign in with your own Arbox account, tap a
class.

**→ https://benpaziguy.github.io/arbox-booker-app/**

Add it to your home screen (Share → *Add to Home Screen*) and it opens full-screen
like an app.

## It has no server

Two files, `index.html` and `arbox.js`. The page talks straight to Arbox's own API
from your browser — the same endpoints the gym's website uses — because Arbox sends
`access-control-allow-origin: *` and permits the request headers involved. GitHub
Pages just hands your browser the file.

That has a pleasant consequence: **your password never passes through any machine
except Arbox's.** There is no backend here to trust, no database, no logs. Your
password is posted once to get a session token; the token lives in `sessionStorage`
and is gone when you close the tab. Only your email is kept, in `localStorage`, and
only if you tick the box.

It also means the page can only do what you could do on the gym's site while signed
in as yourself. It is not a shared service and it holds no accounts.

## What it does

Fourteen days of classes grouped by day, with occupancy, spots free and the coach. A
text filter, and a *Mine* toggle for what you are on. One button per class:

| Button | Meaning |
| --- | --- |
| **Book** | A spot is free and registration is open |
| **Waitlist** | Class is full; joins the standby list |
| **Cancel** | You are booked; cancels it |
| waiting | You are on the standby list |
| Too early | Registration has not opened yet — it shows when it will |

Registration opens 48 hours before most classes and 72 hours before Sunday and
Monday ones, but the page reads the real figure per class rather than assuming, so it
never sends a request the gym will refuse.

Every booking and cancellation is **read back from the server before it reports
success**. This is not caution for its own sake: Arbox's cancel endpoint answers
`200 OK` in some cases where nothing was cancelled. If the change did not take, you
are told so instead of being told it worked.

## Recurring bookings are elsewhere

Booking the same slots every week, automatically, the moment the window opens, is
done by a scheduled job in a separate private repository — not by this page. This
page is for ad-hoc bookings and for checking what you are on.

## Configuration

`arbox.js` is pinned to one gym: `LOCATION_ID = 48`, `BOX_FK = "59"`, whitelabel
`hypr-training`. Point it at another Arbox gym by changing those, but note the
`identifier` header is that gym's too.

Which membership pays is chosen by rule, not by a stored id: an unlimited plan
(`mt_type: "plan"`) is preferred and anything with `sessions_left: 0` is refused, so
an exhausted session pack with a card on file cannot be spent by accident.

## Not affiliated with Arbox

An unofficial client for a member's own account, built by reading what the official
site sends. Arbox may change the API at any time and this will break with it.
