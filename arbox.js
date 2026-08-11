"use strict";

// Talks straight to the Arbox API from your browser. There is no server of mine
// in the middle: Arbox sends `access-control-allow-origin: *`, so a static page
// can log in, read the schedule, book and cancel. That is what makes this work on
// cellular, on any network, with nothing running on a laptop.
//
// Your password is used once to get a token and is never stored. The token goes in
// sessionStorage, so it is gone when you close the tab.

const API = "https://apiappv2.arboxapp.com/api/v2";
const LOCATION_ID = 48;
const BOX_FK = "59";

// Non-secret config the portal sends on every call. `identifier` is capitalised
// differently from the URL slug -- that is Arbox's own inconsistency, not a typo.
const BASE_HEADERS = {
  "content-type": "application/json",
  whitelabel: "hypr-training",
  boxfk: BOX_FK,
  identifier: "jvswOOD31588779247",
  kiosk: "false",
  lang: "en",
  newsite: "1",
  referername: "site",
  version: "10",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TOKEN_KEY = "arbox-token";

let token = sessionStorage.getItem(TOKEN_KEY) || "";
let membershipId = null;
let classes = [];

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- http

// Flatten Arbox's error text into one sentence, whatever shape it arrives in.
//
// The shapes seen so far: a plain string; an array of {name, message, value};
// and -- the one that kept "[object Object]" on screen -- a message that is
// ITSELF an object, because Arbox is bilingual and nests {he, en} (or similar).
// So a fixed one-level {message} read is not enough; this walks the structure
// and collects every string it finds, which cannot produce "[object Object]"
// however the payload is nested. English keys win when a language pair is
// obvious, since the app runs with lang=en.
function messageText(value, depth = 0) {
  if (value == null || depth > 4) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => messageText(v, depth + 1)).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    // A {he, en} / {english, hebrew} language pair: take the English side alone,
    // since the app runs lang=en, rather than concatenating both languages.
    for (const key of ["en", "english", "eng", "message_en"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    // Otherwise read the conventional text-carrying fields ONLY -- never every
    // value, or machine fields like {name:"limit"} would leak into the sentence.
    // Each may itself be a string or a nested language object, so recurse.
    for (const key of ["message", "messageToUser", "text", "description", "he", "hebrew"]) {
      const got = messageText(value[key], depth + 1);
      if (got) return got;
    }
    return "";
  }
  return "";
}

async function call(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = { ...BASE_HEADERS };
  if (auth) headers.accesstoken = token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* some endpoints return empty */ }

  // Only 401 means the session is gone. Arbox also answers 403 for decisions that
  // have nothing to do with authentication -- "You cannot cancel a booking for a
  // user outside your group", and its cancellation-policy refusals. Treating those
  // as an expired session signed you out and hid the real reason, which is how
  // "Leave queue" came to report "Session expired. Sign in again." on a perfectly
  // valid token.
  if (res.status === 401) {
    signOut();
    throw new Error("Session expired. Sign in again.");
  }
  if (!res.ok) {
    // Arbox nests the useful sentence: {error: {messageToUser, message}}. Reading
    // data.error directly yields "[object Object]", so prefer messageToUser --
    // it is the wording the gym's own site shows.
    //
    // messageToUser is usually an ARRAY of {name, message, value} rather than a
    // string, so it needs joining: interpolating it straight into an Error gave
    // "[object Object]" -- the very thing this block exists to prevent. That is how
    // the daily category-limit refusal reached the screen unreadable.
    // Every candidate goes through messageText so a nested/bilingual object can
    // never reach the UI as "[object Object]". messageToUser is the wording the
    // gym's own site shows, so it is preferred; the rest are fallbacks.
    const err = data?.error;
    const msg = messageText(err?.messageToUser) || messageText(err?.message) ||
      messageText(err) || messageText(data?.message) || `HTTP ${res.status}`;
    const out = new Error(msg);
    out.status = res.status;
    // Arbox's own application code is in error.code, and it does not track the HTTP
    // status: 513 ("this would be a late cancellation") arrives as a 4xx. Callers
    // that need to tell one refusal from another read this, not the status.
    out.code = Number(err?.code ?? data?.code) || null;
    throw out;
  }
  return data;
}

// ---------------------------------------------------------------- auth

async function signIn(email, password) {
  const data = await call("/user/siteLogin", {
    method: "POST",
    auth: false,
    body: { email, password, phone: null },
  });
  const tok = data?.data?.token;
  if (!tok) throw new Error("No token in the login response.");
  token = tok;
  sessionStorage.setItem(TOKEN_KEY, token);
}

// Header controls only make sense once there is a session, so they follow the gate.
function showSignedIn(yes) {
  $("#gate").classList.toggle("hidden", yes);
  $("#main").classList.toggle("hidden", !yes);
  $("#tools").classList.toggle("hidden", !yes);
  $("#refresh").classList.toggle("hidden", !yes);
  $("#signout").classList.toggle("hidden", !yes);
  $("#queued-btn").classList.toggle("hidden", !yes);
}

function signOut() {
  token = "";
  membershipId = null;
  sessionStorage.removeItem(TOKEN_KEY);
  // The GitHub token deliberately survives: it is per-phone setup, not part of the
  // gym session, and re-pasting it on every sign-in would make queueing unusable.
  // "Forget" in Queue settings is how you remove it.
  $("#queue-view").classList.add("hidden");
  showSignedIn(false);
}

// Which membership pays. Chosen by RULE, not by a hardcoded id: an unlimited plan
// (mt_type "plan", no session counter) is the safe pick. The alternative on this
// account is a session pack with 0 sessions left and a card on file, and spending
// that could attempt a charge -- so anything with sessions_left === 0 is rejected
// outright, and an ambiguous result asks rather than guesses.
async function resolveMembership() {
  const data = await call(`/boxes/${BOX_FK}/memberships/true`);
  const rows = (data?.data || []).filter((r) => r.active);
  if (!rows.length) throw new Error("No active membership on this account.");

  const usable = rows.filter((r) => r.sessions_left === null || r.sessions_left > 0);
  if (!usable.length) {
    throw new Error("No membership with sessions left. Book on the Arbox site instead.");
  }
  const plan = usable.find((r) => r.mt_type === "plan");
  const chosen = plan || usable[0];
  membershipId = chosen.id;

  if (!plan) {
    toast(`Using a ${chosen.mt_type} membership (no unlimited plan found).`, "warn");
  }
  return membershipId;
}

// ---------------------------------------------------------------- schedule

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Registration opens 72h before Sunday and Monday classes, 48h otherwise -- but
// the API reports the real figure per class, so trust that and only fall back.
function windowHours(row, startsAt) {
  const reported = Number(row.enable_registration_time);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const dow = startsAt.getDay(); // 0=Sun, 1=Mon
  return dow === 0 || dow === 1 ? 72 : 48;
}

// Names live in nested objects on some rows and as plain strings on others.
function text(value) {
  if (value && typeof value === "object") {
    return String(value.name || value.full_name || value.location || "");
  }
  return String(value ?? "");
}

function parseRow(row) {
  const date = String(row.date).slice(0, 10);
  const start = String(row.time || row.start_time || "").slice(0, 5);
  const startsAt = new Date(`${date}T${start}:00`);
  const registered = Number(row.registered ?? 0);
  const limit = Number(row.max_users ?? 0);
  return {
    id: row.id,
    date,
    start,
    name: (text(row.box_categories) || text(row.name) || "Class").trim(),
    coach: (text(row.coach) || text(row.coach_name)).trim(),
    registered,
    limit,
    standby: Number(row.stand_by ?? 0),
    isFull: limit > 0 && registered >= limit,
    spotsLeft: Math.max(0, limit - registered),
    // Which insert Arbox itself intends: "insertScheduleUser" or "insertStandby".
    // Preferred over comparing registered against max_users, because the two can
    // disagree -- a class with max_users 0 reads as "not full" by capacity while
    // Arbox still wants a standby insert. Seen live on a 0/0 class.
    bookingOption: String(row.booking_option || ""),
    bookedByMe: !!row.user_booked,
    inStandby: !!row.user_in_standby,
    // Cancelling needs the id of the BOOKING, not of the class -- without it,
    // scheduleUser/delete returns a cheerful 200 and cancels nothing.
    //
    // These two are SEPARATE ID SPACES and must never be collapsed into one field.
    // A seat is a schedule_user row (9 digits here); a waiting-list place is a
    // schedule_stand_by row (8 digits). They go to different endpoints under
    // different parameter names. Passing a stand-by id as schedule_user_id is a
    // valid-looking id for a row that is not yours, and Arbox answers 403 "You
    // cannot cancel a booking for a user outside your group" -- which reads like a
    // permissions problem and is really a wrong-id problem.
    bookingId: row.user_booked || null,
    standById: row.user_in_standby || null,
    isPast: !!row.past || startsAt < new Date(),
    startsAt,
    opensAt: new Date(startsAt.getTime() - windowHours(row, startsAt) * 3600 * 1000),
  };
}

async function loadSchedule() {
  const from = new Date();
  const to = new Date(from.getTime() + 14 * 86400 * 1000);
  const data = await call("/schedule/betweenDates", {
    method: "POST",
    body: { from: ymd(from), to: ymd(to), locations_box_id: LOCATION_ID },
  });
  classes = (data?.data || []).map(parseRow).filter((c) => !c.isPast);
  classes.sort((a, b) => a.startsAt - b.startsAt);
  render();
}

// ---------------------------------------------------------------- booking

// Whether joining this class means the waiting list rather than taking a seat.
//
// One function, used by both the button label and the request, so the card cannot
// promise "Book" while book() sends a standby insert.
//
// Arbox's own `booking_option` decides it when present -- that is the server stating
// which insert it will accept. Capacity is only the fallback, because the two
// disagree: a class with `max_users: 0` reads as "not full" by capacity while Arbox
// still wants a standby insert. Seen live on a 0/0 class; 51 of 52 upcoming classes
// agreed, and that one did not.
function needsStandby(cls) {
  if (cls.bookingOption === "insertStandby") return true;
  if (cls.bookingOption === "insertScheduleUser") return false;
  return cls.isFull;
}

async function book(cls, viaWaitlist) {
  if (!membershipId) await resolveMembership();

  // Taking a seat and joining the waiting list are DIFFERENT endpoints, exactly as
  // giving them up is. The payload is identical -- the portal builds it once and
  // switches only the URL -- so the mistake is easy to make and does not look like
  // a mistake:
  //
  //   scheduleUser/insert     a free seat
  //   scheduleStandBy/insert  a full class
  //
  // Sending the seat endpoint for a full class draws Arbox's own sentence,
  // "Schedule is full, refresh the schedule page by dragging it down and subscribe
  // to the waiting list" -- advice aimed at someone looking at a stale page, which
  // is misleading here: the page was current and the request was simply the wrong
  // one.
  //
  // `viaWaitlist` says what the user consented to; needsStandby() says what Arbox
  // will accept. A class that filled between the last refresh and the tap must go to
  // standby too, or the race reports failure for something that would have worked.
  const standby = needsStandby(cls);
  if (standby && !viaWaitlist) {
    // Book was tapped on a class that has since filled. Joining a queue is a
    // different commitment from taking a seat, so ask rather than silently doing it.
    throw new Error(`${cls.name} filled up just now. Tap Waitlist to join the queue.`);
  }

  try {
    await call(standby ? "/scheduleStandBy/insert" : "/scheduleUser/insert", {
      method: "POST",
      // Verified against what the real portal sends -- one builder for both endpoints.
      // `membership_user_id` -- the schedule rows call the same concept
      // membership_user_fk, which is wrong here.
      body: { extras: null, membership_user_id: membershipId, schedule_id: cls.id },
    });
  } catch (err) {
    // The membership caps SEATS per category per day -- one W.O.D a day here -- and
    // nothing on the schedule row hints at it: the class that hit this reported
    // booking_option "insertScheduleUser" with 4 of 20 seats free. Only the insert
    // tells you. Queue places are not capped, so say so, because that is the one
    // thing the user can still do on that day.
    if (/reached your limit for category registrations|הגעת למגבלת הרשמות/.test(err.message)) {
      throw new Error(
        `${err.message} ` +
        (standby ? "" : "A waiting-list place is still allowed, or cancel your other class that day."),
      );
    }
    throw err;
  }

  // Don't trust the 200 alone: re-read and confirm the place is really ours. A
  // cancellation taught us these endpoints can answer 200 and do nothing.
  await loadSchedule();
  const now = classes.find((c) => c.id === cls.id);
  if (now && !now.bookedByMe && !now.inStandby) {
    throw new Error("Arbox accepted the request but you are not on the list.");
  }
  // What happened is read from the server, not assumed from the request: a standby
  // insert can convert straight to a seat if someone drops out in between.
  const waitlisted = now ? (now.inStandby && !now.bookedByMe) : standby;
  toast(waitlisted ? `On the waiting list for ${cls.name} at ${cls.start}.`
                   : `Booked ${cls.name} at ${cls.start}.`, "ok");
}

// Whether cancelling this seat counts as a late cancellation. Arbox does not
// answer this in a response body -- checkLateCancel returns 200 with nothing in it
// when you are inside the free window, and THROWS with error code 513 when you are
// not. So the answer is carried by the failure, which is why reading
// `data.late_cancel` always produced false. Straight from the portal's own code:
//
//     try{await _0("scheduleUser/checkLateCancel","post",{schedule_id:e.id})}
//     catch(e){t=513===e.error.code}
//
// Advisory either way: any other failure falls through as "not late", exactly as
// the portal does. A 401 is the exception -- call() has already signed us out, and
// pressing on would send a tokenless delete whose 401 reads as if the cancellation
// itself had been rejected.
async function isLateCancel(cls) {
  try {
    await call("/scheduleUser/checkLateCancel", {
      method: "POST",
      body: { schedule_id: cls.id },
    });
    return false;
  } catch (err) {
    if (err.status === 401 || /Session expired/.test(err.message)) throw err;
    return err.code === 513 || err.status === 513;
  }
}

async function cancel(cls) {
  // A waiting-list place and a booked seat are cancelled by different endpoints,
  // and the page must not guess: `leaving` decides both the request and the wording.
  // Prefer the real seat when a row somehow carries both, because that is the one
  // that actually holds a place in the class.
  const leaving = !cls.bookedByMe && cls.inStandby;
  const id = leaving ? cls.standById : cls.bookingId;
  if (!id) {
    throw new Error(leaving
      ? "Cannot find this waiting-list place's id. Refresh and try again."
      : "Cannot find this booking's id. Refresh and try again.");
  }

  // Leaving a queue is never late -- you are giving up a place you never had, so
  // there is no cancellation policy to breach and the portal does not ask.
  const late = leaving ? false : await isLateCancel(cls);

  try {
    // Both taken verbatim from the portal bundle's dispatch on booking_option:
    //   CANCEL_WAIT_LIST      -> scheduleStandBy/delete {schedule_stand_by_id}
    //   CANCEL_SCHEDULE_USER  -> scheduleUser/delete    {schedule_user_id, schedule_id, late_cancel}
    // Note the stand-by call sends neither schedule_id nor late_cancel.
    await (leaving
      ? call("/scheduleStandBy/delete", {
        method: "POST",
        body: { schedule_stand_by_id: id },
      })
      : call("/scheduleUser/delete", {
        method: "POST",
        body: { schedule_user_id: id, schedule_id: cls.id, late_cancel: late },
      }));
  } catch (err) {
    // Say which action failed and let Arbox's own sentence stand. A 403 here is a
    // policy decision -- too late to cancel, or a booking the account may not
    // touch -- not a broken session, so the wording must not send you to sign in.
    if (err.status === 403) {
      throw new Error(`${leaving ? "Could not leave the waiting list" : "Could not cancel"}: ` +
        `${err.message} (Arbox refused it, your session is fine.)`);
    }
    throw err;
  }

  // The 200 above is necessary but not sufficient, so confirm from the server.
  await loadSchedule();
  const still = classes.find((c) => c.id === cls.id);
  if (still && (still.bookedByMe || still.inStandby)) {
    throw new Error(leaving
      ? "Arbox accepted the request but you are still on the waiting list."
      : "Arbox accepted the request but the booking is still there.");
  }

  // Cancelling is not enough on its own. If a recurring rule wants this slot, the
  // seat is now free and the next scheduler run -- within half an hour -- books it
  // straight back. That is not a delay in the cancellation; it is the automation
  // correctly doing what it was told. So record "not this date" as well.
  //
  // Any failure here is reported, never swallowed: a cancellation that silently
  // fails to stop the rule reads as success and reappears as a booking.
  let note = "";
  try {
    const { rule } = await ruleStateFor(cls);
    if (rule) {
      await setSkip(rule.id, cls.date, true);
      note = ` ${rule.id} will skip this week and resume as normal after.`;
    }
  } catch (err) {
    note = ` Warning: could not stop the recurring rule rebooking it (${err.message}).`;
  }

  // A queued one-off for the same class would rebook it too, and it is ours to
  // remove rather than skip.
  try {
    if (queueConfigured()) {
      const rows = await listQueued();
      const match = rows.find((r) =>
        r.date === cls.date && String(r.time || "").slice(0, 5) === cls.start &&
        String(r.class_name || "").toLowerCase() === cls.name.toLowerCase());
      if (match) {
        await unqueueId(match.id);
        queuedIds.delete(queueKey(cls));
        note += " Its queued request was removed too.";
      }
    }
  } catch (err) {
    note += ` Warning: a queued request for it may remain (${err.message}).`;
  }

  toast(`${leaving ? "Left the waiting list for" : "Cancelled"} ${cls.name} ` +
        `at ${cls.start}.${note}`, "ok");
}

// Which classes have a pending request, so a card can show "Queued" rather than
// offering to queue it twice. Keyed by date+time+name, matching the duplicate rule
// in scheduler.queue_once.
const queuedIds = new Set();

// The recurring rules and the dates they are skipping, cached from the same fetch.
// A card needs these to say "every Tuesday" rather than treating a rule's class as
// an anonymous booking.
let ghRules = [];
let ghSkips = [];

function queueKey(cls) {
  return `${cls.date}|${cls.start}|${cls.name.toLowerCase()}`;
}

// The rule that will book this class, and whether this date is skipped -- from the
// cache, so rendering costs no requests.
function ruleFor(cls) {
  const rule = matchRule(ghRules, cls);
  if (!rule) return { rule: null, skipped: false };
  return {
    rule,
    skipped: ghSkips.some((s) =>
      s && String(s.rule) === String(rule.id) && String(s.date) === cls.date),
  };
}

async function refreshQueued({ quiet = true } = {}) {
  if (!queueConfigured()) {
    queuedIds.clear();
    ghRules = [];
    ghSkips = [];
    return;
  }
  try {
    const state = await loadScheduleState();
    queuedIds.clear();
    for (const r of state.once) {
      queuedIds.add(`${r.date}|${String(r.time || "").slice(0, 5)}|${String(r.class_name || "").toLowerCase()}`);
    }
    ghRules = state.rules;
    ghSkips = state.skips;
  } catch (err) {
    // A bad token must not stop the schedule rendering -- booking still works
    // without queueing, and the error surfaces when they actually tap Queue.
    queuedIds.clear();
    ghRules = [];
    ghSkips = [];
    if (!quiet) toast(err.message, "bad");
  }
}

async function act(cls, kind, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    if (kind === "cancel") {
      await cancel(cls);
    } else if (kind === "queue") {
      if (!queueConfigured()) {
        showQueue();
        $("#queue-setup").open = true;
        throw new Error("Add a GitHub token first — this is a one-time setup.");
      }
      const entry = await queueClass(cls, true);
      queuedIds.add(queueKey(cls));
      const when = cls.opensAt.toLocaleString([], {
        weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
      toast(`Queued ${cls.name} — claimed automatically at ${when}. (${entry.id})`, "ok");
    } else if (kind === "unqueue") {
      const rows = await listQueued();
      const match = rows.find((r) =>
        r.date === cls.date && String(r.time || "").slice(0, 5) === cls.start &&
        String(r.class_name || "").toLowerCase() === cls.name.toLowerCase());
      if (match) await unqueueId(match.id);
      queuedIds.delete(queueKey(cls));
      toast(`No longer queued: ${cls.name} at ${cls.start}.`, "ok");
    } else if (kind === "skip" || kind === "unskip") {
      const { rule } = ruleFor(cls);
      if (!rule) throw new Error("No recurring rule matches this class.");
      await setSkip(rule.id, cls.date, kind === "skip");
      await refreshQueued({ quiet: false });
      toast(kind === "skip"
        ? `Skipping ${cls.name} on ${cls.date}. ${rule.id} resumes next week.`
        : `${rule.id} will book ${cls.name} on ${cls.date} again.`, "ok");
    } else {
      await book(cls, kind === "waitlist");
    }
    await loadSchedule();
  } catch (err) {
    // 425 means the window is not open yet; Arbox's own wording is clearer here.
    toast(err.message, "bad");
    button.disabled = false;
    button.textContent = original;
  }
}

// ---------------------------------------------------------------- render

function card(cls) {
  const el = document.createElement("div");
  el.className = "card" + (cls.bookedByMe ? " booked" : "") + (cls.isFull ? " full" : "");

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = cls.start;

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = cls.name;
  const sub = document.createElement("div");
  sub.className = "sub";

  let detail = `${cls.registered}/${cls.limit}`;
  if (cls.isFull && cls.standby) detail += ` · ${cls.standby} waiting`;
  else if (!cls.isFull) detail += ` · ${cls.spotsLeft} free`;
  if (cls.coach) detail += ` · ${cls.coach}`;
  const open = cls.opensAt <= new Date();
  if (!open) {
    detail += ` · opens ${DAYS[(cls.opensAt.getDay() + 6) % 7].slice(0, 3)} ` +
      `${cls.opensAt.getHours()}:${String(cls.opensAt.getMinutes()).padStart(2, "0")}`;
  }
  // Say when a weekly rule owns this slot, and when it is standing down. Without
  // this the page cannot explain why a class you never tapped is booked, or why
  // one you cancelled came back.
  const { rule, skipped } = ruleFor(cls);
  const held = cls.bookedByMe || cls.inStandby;
  // Say when a weekly rule owns this slot. The skip state is only worth mentioning
  // while the seat is not yours: once you hold it, the skip governs nothing you can
  // see -- it only stops the automation re-claiming the slot if you cancel.
  if (rule) detail += held ? " · weekly" : (skipped ? " · weekly, skipping" : " · weekly");
  sub.textContent = detail;
  meta.append(name, sub);

  // Two independent questions, so two buttons rather than one ranked list.
  //
  //   1. do I have a place in this class, and do I want one?      -> primary
  //   2. should the weekly rule claim this date?                  -> secondary
  //
  // These used to share a single button, ranked with the rule first, which meant a
  // class a rule owned could never be booked by hand: the card offered only Skip or
  // Skipped. That is wrong in the ordinary case -- deciding to go tonight after all
  // is not the same as changing what the automation does every Tuesday.
  const actions = document.createElement("div");
  actions.className = "actions";

  const btn = document.createElement("button");
  let primary = true;
  if (cls.bookedByMe) {
    btn.className = "btn danger";
    btn.textContent = "Cancel";
    btn.onclick = () => act(cls, "cancel", btn);
  } else if (cls.inStandby) {
    // A standby place is a commitment too: it can convert to a real seat, and
    // leaving the queue is the only way to say "not today". cancel() sends the
    // stand-by endpoint for it -- the seat endpoint refuses a stand-by id.
    btn.className = "btn danger";
    btn.textContent = "Leave queue";
    btn.onclick = () => act(cls, "cancel", btn);
  } else if (open) {
    // The window is open, so this is bookable right now whatever the rules say.
    // The label must be decided by the same signal book() routes on, or the button
    // says Book and the request goes to standby.
    if (needsStandby(cls)) {
      btn.className = "btn ghost";
      btn.textContent = "Waitlist";
      btn.onclick = () => act(cls, "waitlist", btn);
    } else {
      btn.className = "btn";
      btn.textContent = "Book";
      btn.onclick = () => act(cls, "book", btn);
    }
  } else if (rule && !skipped) {
    // Not open yet, and the rule is already going to claim it the moment it is.
    // Queueing on top of that would be a second request for the same seat, so the
    // rule chip below is the only useful control here. Nothing is suppressed that
    // could have done anything: booking now would be refused with a 425.
    primary = false;
  } else if (queuedIds.has(queueKey(cls))) {
    btn.className = "btn ghost";
    btn.textContent = "Queued";
    btn.onclick = () => act(cls, "unqueue", btn);
  } else {
    // Booking now would be refused with a 425. Queue it instead: the request is
    // written to the repo and claimed by GitHub Actions when the window opens.
    // This is the only thing here the gym's own site cannot do.
    btn.className = "btn warnish";
    btn.textContent = "Queue";
    btn.onclick = () => act(cls, "queue", btn);
  }
  if (primary) actions.append(btn);

  // The rule control, shown alongside. Pointless once the seat is yours -- the
  // automation checks for that and stands down on its own -- and cancel() sets the
  // skip anyway, so offering it there would just be a second way to say the same
  // thing.
  if (rule && !held) {
    const chip = document.createElement("button");
    chip.className = skipped ? "btn ghost small" : "btn warnish small";
    chip.textContent = skipped ? "Skipped" : "Skip";
    chip.title = skipped
      ? `${rule.id} is standing down on this date. Tap to let it book again.`
      : `${rule.id} will book this automatically. Tap to skip just this date.`;
    chip.onclick = () => act(cls, skipped ? "unskip" : "skip", chip);
    actions.append(chip);
  }

  el.append(time, meta, actions);
  return el;
}

function render() {
  const host = $("#list");
  host.textContent = "";
  const filter = $("#filter").value.trim().toLowerCase();
  const mineOnly = $("#mine-only").checked;

  const shown = classes.filter((c) => {
    if (mineOnly && !c.bookedByMe && !c.inStandby) return false;
    return !filter || c.name.toLowerCase().includes(filter);
  });

  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = mineOnly ? "You are not booked on anything." : "Nothing matches.";
    host.append(p);
    return;
  }

  let day = null;
  const today = ymd(new Date());
  for (const cls of shown) {
    if (cls.date !== day) {
      day = cls.date;
      const h = document.createElement("div");
      h.className = "day-title";
      const d = new Date(day + "T00:00:00");
      h.textContent = (day === today ? "Today · " : "") +
        `${DAYS[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1}`;
      host.append(h);
    }
    host.append(card(cls));
  }
}

// ---------------------------------------------------------------- queue view

function showQueue() {
  $("#main").classList.add("hidden");
  $("#queue-view").classList.remove("hidden");
  $("#gh-repo").value = ghRepo;
  // Name the repo in the instructions, so "Only select repositories" says which one
  // instead of leaving you to match it up against the field below.
  $("#gh-repo-label").textContent = ghRepo;
  renderQueue();
}

function hideQueue() {
  $("#queue-view").classList.add("hidden");
  $("#main").classList.remove("hidden");
}

async function renderQueue() {
  const host = $("#queue-list");
  host.textContent = "";

  if (!queueConfigured()) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Queueing is not set up yet — open Queue settings below.";
    host.append(p);
    $("#queue-setup").open = true;
    return;
  }

  let rows;
  try {
    rows = await listQueued();
  } catch (err) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = err.message;
    host.append(p);
    return;
  }

  const today = ymd(new Date());
  // A past request is inert rather than wrong -- it matches no class, so the
  // scheduler ignores it. Hiding it keeps this list about what will happen.
  const pending = rows.filter((r) => String(r.date) >= today);
  if (!pending.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Nothing queued. Tap Queue on a class that is not open yet.";
    host.append(p);
    return;
  }

  for (const r of pending) {
    const el = document.createElement("div");
    el.className = "card";

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = String(r.time || "").slice(0, 5);

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = r.class_name;
    const sub = document.createElement("div");
    sub.className = "sub";

    // Cross-check against the live schedule, so a stale or misspelled request is
    // visible here instead of silently booking nothing.
    const live = classes.find((c) =>
      c.date === r.date && c.start === String(r.time || "").slice(0, 5) &&
      c.name.toLowerCase() === String(r.class_name || "").toLowerCase());
    const d = new Date(r.date + "T00:00:00");
    let state = `${DAYS[(d.getDay() + 6) % 7].slice(0, 3)} ${d.getDate()}/${d.getMonth() + 1}`;
    if (!live) state += " · not in the schedule";
    else if (live.bookedByMe) state += " · booked ✓";
    else if (live.inStandby) state += " · on the waiting list";
    else if (live.opensAt <= new Date()) state += " · window open, books on the next run";
    else state += ` · opens ${live.opensAt.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
    if (r.enabled === false) state += " · paused";
    sub.textContent = state;
    meta.append(name, sub);

    // Removing a request that has already been fulfilled is the trap worth
    // guarding: the entry disappears, so the page looks like it worked, while the
    // real seat stays booked and you turn up or lose it late. Once the seat exists
    // the only honest action is to cancel it with Arbox, so say so on the button.
    const done = live && (live.bookedByMe || live.inStandby);
    const btn = document.createElement("button");
    btn.className = "btn danger small";
    btn.textContent = done ? "Cancel" : "Remove";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        if (done) {
          // cancel() removes the queued request itself, and skips a matching rule.
          await cancel(live);
        } else {
          await unqueueId(r.id);
          if (live) queuedIds.delete(queueKey(live));
          toast(`Removed ${r.class_name} on ${r.date}.`, "ok");
        }
        await renderQueue();
        render();
      } catch (err) {
        toast(err.message, "bad");
        btn.disabled = false;
        btn.textContent = done ? "Cancel" : "Remove";
      }
    };

    el.append(time, meta, btn);
    host.append(el);
  }
}

function toast(message, kind) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), kind === "bad" ? 9000 : 5000);
}

// ---------------------------------------------------------------- wiring

async function start() {
  showSignedIn(true);
  try {
    await loadSchedule();
    // Queued state before membership: it changes what every card shows, and a
    // membership problem should not leave the buttons wrong.
    await refreshQueued();
    render();
    await resolveMembership();
  } catch (err) {
    toast(err.message, "bad");
  }
}

$("#signin").onclick = async () => {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) return;
  const btn = $("#signin");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await signIn(email, password);
    if ($("#remember").checked) localStorage.setItem("arbox-email", email);
    await start();
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
};

$("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#signin").click(); });
$("#filter").addEventListener("input", render);
$("#mine-only").addEventListener("change", render);
$("#refresh").onclick = () =>
  loadSchedule().then(() => refreshQueued()).then(render).catch((e) => toast(e.message, "bad"));
$("#signout").onclick = signOut;

$("#queued-btn").onclick = () => {
  if ($("#queue-view").classList.contains("hidden")) showQueue(); else hideQueue();
};
$("#queue-back").onclick = hideQueue;

$("#gh-save").onclick = async () => {
  // The repo is prefilled, so in practice the token is the only thing to type.
  const repo = $("#gh-repo").value.trim() || ghRepo;
  const tok = $("#gh-token").value.trim() || ghToken;
  if (!tok) return toast("Paste a GitHub token.", "bad");
  if (!repo) return toast("Give the repository, e.g. you/arbox-booker.", "bad");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.replace(/^https?:\/\/github\.com\//, ""))) {
    return toast("Repository should look like you/arbox-booker.", "bad");
  }
  saveQueueConfig(repo, tok);
  // Prove it works now rather than at 03:00: read the file back before claiming
  // the setup is done.
  try {
    await listQueued();
  } catch (err) {
    return toast(err.message, "bad");
  }
  $("#gh-token").value = "";
  $("#queue-setup").open = false;
  toast("Queueing is set up on this phone.", "ok");
  await refreshQueued({ quiet: false });
  await renderQueue();
  render();
};

$("#gh-forget").onclick = () => {
  forgetQueueConfig();
  $("#gh-repo").value = "";
  $("#gh-token").value = "";
  queuedIds.clear();
  toast("Token removed from this phone.", "ok");
  renderQueue();
  render();
};

$("#email").value = localStorage.getItem("arbox-email") || "";

// A token in sessionStorage means this tab was already signed in.
if (token) start(); else showSignedIn(false);
