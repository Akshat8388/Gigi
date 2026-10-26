const TARGET_URL =
  "https://gsk.service-now.com/now/nav/ui/classic/params/target/incident_list.do%3Fsysparm_query%3Dactive%253Dtrue%255EGOTOassignment_group.nameSTARTSWITHGiGi%255Eassigned_toISEMPTY%26sysparm_first_row%3D1%26sysparm_view%3D";

const ALARM_NAME = "reload-ticket-list";
const ALARM_STOP = "stop-alarm-sound"; // auto-silence timer
const ALARM_MAX_MINUTES = 3;
const TAB_KEY = "ticketTabId";
const MAX_LOGS = 50;
const MAX_SEEN = 500;
// ---- Route button settings ----
const ROUTE_GROUP = "TechServiceDesk-Global-English-L1";
const ROUTE_GROUP_ID = "38feda721b7f54101757773e0d4bcb98";
const ROUTE_NOTE = "This issue is not related to GiGi, hence routing to Service Desk.";

// ---------- helpers ----------
// Serialise storage read-modify-write so parallel jobs don't overwrite each other
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn);
  lockChain = run.catch(() => {});
  return run;
}

function log(msg) {
  return withLock(async () => {
    const { logs = [] } = await chrome.storage.local.get("logs");
    logs.unshift({ time: Date.now(), msg });
    await chrome.storage.local.set({ logs: logs.slice(0, MAX_LOGS) });
  });
}

// fn(pendingObject) may mutate it and may return a value
function updatePending(fn) {
  return withLock(async () => {
    const { pending = {} } = await chrome.storage.local.get("pending");
    const out = fn(pending);
    await chrome.storage.local.set({ pending });
    return out;
  });
}

async function getTrackedTab() {
  const data = await chrome.storage.session.get(TAB_KEY);
  const tabId = data[TAB_KEY];
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

// Open the URL in a tab (reuse ours if it still exists) and start the alarm
async function openTabAndSchedule() {
  const existing = await getTrackedTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { url: TARGET_URL, active: true });
  } else {
    const tab = await chrome.tabs.create({ url: TARGET_URL });
    await chrome.storage.session.set({ [TAB_KEY]: tab.id });
  }
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

// ---------- start / stop ----------
async function startMonitoring(name) {
  // Fresh run: forget old tickets; first scan becomes the baseline
  await chrome.storage.local.set({
    running: true,
    name,
    seen: [],
    baselined: false,
    pending: {},
    replySince: String(Math.floor(Date.now() / 1000)),
  });
  await openTabAndSchedule();
  await log(`Monitoring started by ${name}`);
}

async function stopMonitoring(reason = "Monitoring stopped") {
  await chrome.storage.local.set({ running: false });
  await stopAlarmSound();
  await chrome.alarms.clear(ALARM_NAME);
  await log(reason);
}

// ---------- new ticket handling ----------
async function handleScan(tickets, senderTabId) {
  const { running, seen = [], baselined } = await chrome.storage.local.get([
    "running",
    "seen",
    "baselined",
  ]);
  if (!running) return;

  // Only trust scans coming from our own monitored tab
  const tracked = await getTrackedTab();
  if (!tracked || tracked.id !== senderTabId) return;

  const seenSet = new Set(seen);

  // First scan after Start: note existing tickets, don't open them
  if (!baselined) {
    tickets.forEach((t) => seenSet.add(t.number));
    await chrome.storage.local.set({ seen: [...seenSet].slice(-MAX_SEEN), baselined: true });
    return;
  }

  const fresh = tickets.filter((t) => !seenSet.has(t.number));
  if (!fresh.length) return;

  // Save first so the same ticket is never opened twice
  fresh.forEach((t) => seenSet.add(t.number));
  await chrome.storage.local.set({ seen: [...seenSet].slice(-MAX_SEEN) });

  try {
    await startAlarm(fresh.map((t) => t.number));
  } catch (e) {
    await log(`Alarm could not start (${e.message})`);
  }

  const jobs = [];
  for (const t of fresh) {
    const tab = await chrome.tabs.create({ url: t.url, active: false });
    await log(`New ticket ${t.number} opened in new tab`);
    jobs.push(notifyTicket(tab.id, t));
  }
  await Promise.allSettled(jobs);
}

// ---------- assigning a ticket to the logged-in user ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// Runs a function in the page's own JS world (where g_form / g_user exist),
// in all frames. Returns the first non-null result, or null.
async function runInForm(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func,
      args,
    });
    const hit = results.find((r) => r && r.result != null);
    return hit ? hit.result : null;
  } catch {
    return null; // tab still loading / frame navigating - caller retries
  }
}

// NOTE: the two functions below are injected into the page, so they must be
// fully self-contained (no references to anything outside themselves).
async function assignInPage() {
  if (!location.pathname.endsWith("incident.do")) return null; // not the form frame

  const t0 = Date.now();
  while (
    typeof g_form === "undefined" ||
    typeof g_user === "undefined" ||
    !g_form.getValue("number")
  ) {
    if (Date.now() - t0 > 15000) return { status: "error", detail: "form did not load" };
    await new Promise((r) => setTimeout(r, 500));
  }

  const number = g_form.getValue("number");

  // Safety: never take over a ticket that already has an owner
  if (g_form.getValue("assigned_to")) {
    let who = "";
    try {
      const box = document.getElementById("sys_display.incident.assigned_to");
      who = box ? box.value : "";
    } catch (e) {}
    return { status: "skipped", number, who };
  }

  g_form.setValue("assigned_to", g_user.userID, g_user.fullName);
  if (g_form.getValue("assigned_to") !== g_user.userID) {
    return { status: "error", number, detail: "could not set Assigned to" };
  }

  window.__trSaving = true; // marker: disappears after the page reloads post-save
  g_form.save();
  return { status: "submitted", number, userName: g_user.fullName };
}

function verifyInPage() {
  if (!location.pathname.endsWith("incident.do")) return null;
  if (typeof g_form === "undefined" || typeof g_user === "undefined") return { state: "loading" };
  if (window.__trSaving) return { state: "pending" }; // still the old page
  return { state: g_form.getValue("assigned_to") === g_user.userID ? "saved" : "notsaved" };
}

async function assignTicket(tabId, number) {
  try {
    // 1) wait for the form and assign (up to ~60 s)
    let res = null;
    for (let i = 0; i < 30 && !res; i++) {
      await sleep(2000);
      if (!(await tabExists(tabId))) return;
      res = await runInForm(tabId, assignInPage);
    }
    if (!res) return log(`${number}: form did not load - not assigned`);
    if (res.status === "skipped") {
      return log(`${number}: already assigned${res.who ? " to " + res.who : ""} - skipped`);
    }
    if (res.status === "error") return log(`${number}: assign failed (${res.detail})`);

    // 2) confirm the save really went through (page reloads after save)
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      if (!(await tabExists(tabId))) return;
      const v = await runInForm(tabId, verifyInPage);
      if (v && v.state === "saved") return log(`${number} assigned to ${res.userName}`);
      if (v && v.state === "notsaved") return log(`${number}: save did not stick - check the tab`);
    }
    await log(`${number}: could not confirm save - check the tab`);
  } catch (e) {
    await log(`${number}: assign error - ${e.message}`);
  }
}

// ---------- alarm sound (laptop) ----------
// An offscreen document plays alarm.wav in a loop; closing it stops the sound.
async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play an alarm when a new ticket arrives",
    });
  } catch (e) {
    if (!String(e.message).includes("single offscreen")) throw e; // already ringing is fine
  }
}

async function startAlarm(numbers) {
  await withLock(async () => {
    const { alarmSet = [] } = await chrome.storage.local.get("alarmSet");
    await chrome.storage.local.set({ alarmSet: [...new Set([...alarmSet, ...numbers])] });
  });
  await ensureOffscreen();
  await chrome.alarms.create(ALARM_STOP, { delayInMinutes: ALARM_MAX_MINUTES });
}

async function stopAlarmSound() {
  await withLock(() => chrome.storage.local.set({ alarmSet: [] }));
  await chrome.alarms.clear(ALARM_STOP);
  try {
    await chrome.offscreen.closeDocument();
  } catch {} // nothing was ringing
}

// A ticket got its answer - silence only when every waiting ticket is answered
async function alarmResolve(number) {
  const remaining = await withLock(async () => {
    const { alarmSet = [] } = await chrome.storage.local.get("alarmSet");
    const next = alarmSet.filter((n) => n !== number);
    await chrome.storage.local.set({ alarmSet: next });
    return next;
  });
  if (!remaining.length) await stopAlarmSound();
}

// ---------- routing a ticket to another group ----------
// Injected into the ticket page (self-contained)
async function routeInPage(groupId, groupName, note) {
  if (!location.pathname.endsWith("incident.do")) return null;

  const t0 = Date.now();
  while (
    typeof g_form === "undefined" ||
    typeof g_user === "undefined" ||
    !g_form.getValue("number")
  ) {
    if (Date.now() - t0 > 15000) return { status: "error", detail: "form did not load" };
    await new Promise((r) => setTimeout(r, 500));
  }

  const number = g_form.getValue("number");

  // Safety: don't touch a ticket somebody already owns
  if (g_form.getValue("assigned_to")) {
    let who = "";
    try {
      const box = document.getElementById("sys_display.incident.assigned_to");
      who = box ? box.value : "";
    } catch (e) {}
    return { status: "skipped", number, who };
  }

  g_form.setValue("assignment_group", groupId, groupName);
  if (g_form.getValue("assignment_group") !== groupId) {
    return { status: "error", number, detail: "could not set Assignment group" };
  }
  if (note) g_form.setValue("work_notes", note);

  window.__trSaving = true; // marker: disappears after the page reloads post-save
  g_form.save();
  return { status: "submitted", number, groupId, groupName };
}

function verifyFieldInPage(field, expected) {
  if (!location.pathname.endsWith("incident.do")) return null;
  if (typeof g_form === "undefined") return { state: "loading" };
  if (window.__trSaving) return { state: "pending" }; // still the old page
  return { state: g_form.getValue(field) === expected ? "saved" : "notsaved" };
}

async function routeTicket(tabId, number) {
  try {
    let res = null;
    for (let i = 0; i < 30 && !res; i++) {
      await sleep(2000);
      if (!(await tabExists(tabId))) return;
      res = await runInForm(tabId, routeInPage, [ROUTE_GROUP_ID, ROUTE_GROUP, ROUTE_NOTE]);
    }
    if (!res) return log(`${number}: form did not load - not routed`);
    if (res.status === "skipped") {
      return log(`${number}: already assigned${res.who ? " to " + res.who : ""} - not routed`);
    }
    if (res.status === "error") return log(`${number}: route failed (${res.detail})`);

    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      if (!(await tabExists(tabId))) return;
      const v = await runInForm(tabId, verifyFieldInPage, ["assignment_group", res.groupId]);
      if (v && v.state === "saved") return log(`${number} routed to ${res.groupName}`);
      if (v && v.state === "notsaved") return log(`${number}: route did not save - check the tab`);
    }
    await log(`${number}: could not confirm route - check the tab`);
  } catch (e) {
    await log(`${number}: route error - ${e.message}`);
  }
}

// ---------- phone alerts + replies (ntfy) ----------
function randomId(n = 20) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => (b % 36).toString(36)).join("");
}

// Two private, random topics: one you subscribe to on the phone, one the buttons reply to
async function ensureTopics() {
  let { ntfyTopic, ntfyReplyTopic } = await chrome.storage.local.get(["ntfyTopic", "ntfyReplyTopic"]);
  if (!ntfyTopic) ntfyTopic = "gigi-" + randomId();
  if (!ntfyReplyTopic) ntfyReplyTopic = "gigi-r-" + randomId();
  await chrome.storage.local.set({ ntfyTopic, ntfyReplyTopic });
  return { ntfyTopic, ntfyReplyTopic };
}

async function sendNtfy(payload) {
  const { ntfyTopic } = await ensureTopics();
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: ntfyTopic, ...payload }),
  });
  if (!res.ok) throw new Error("ntfy " + res.status);
}

// A notification button that posts "<INC>|<action>" back to the reply topic
function replyAction(label, replyTopic, body) {
  return {
    action: "http",
    label,
    url: `https://ntfy.sh/${replyTopic}`,
    method: "POST",
    body,
    clear: true,
  };
}

// Injected into the ticket page (self-contained)
async function readInPage() {
  if (!location.pathname.endsWith("incident.do")) return null;
  const t0 = Date.now();
  while (typeof g_form === "undefined" || !g_form.getValue("number")) {
    if (Date.now() - t0 > 15000) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    number: g_form.getValue("number"),
    short: g_form.getValue("short_description") || "",
    desc: g_form.getValue("description") || "",
  };
}

async function notifyTicket(tabId, ticket) {
  const number = ticket.number;
  try {
    let info = null;
    for (let i = 0; i < 30 && !info; i++) {
      await sleep(2000);
      if (!(await tabExists(tabId))) return;
      info = await runInForm(tabId, readInPage);
    }
    if (!info) {
      await log(`${number}: could not read description - no phone alert`);
      return;
    }

    const { ntfyReplyTopic } = await ensureTopics();
    const short = info.short.trim();
    const desc = info.desc.trim().slice(0, 500);
    const message =
      [short, desc && desc !== short ? desc : ""].filter(Boolean).join("\n\n") || "(no description)";

    await sendNtfy({
      title: `New ticket ${number}`,
      message,
      priority: 4,
      tags: ["ticket"],
      actions: [
        replyAction("Assign to me", ntfyReplyTopic, `${number}|assign`),
        replyAction("Route to TechService", ntfyReplyTopic, `${number}|route`),
      ],
    });

    await updatePending((p) => {
      p[number] = { tabId, url: ticket.url, ts: Date.now() };
    });
    await log(`${number}: phone alert sent`);
    startFastPoll();
  } catch (e) {
    await log(`${number}: phone alert failed (${e.message})`);
  }
}

async function sendTest() {
  try {
    const { ntfyReplyTopic } = await ensureTopics();
    await sendNtfy({
      title: "Ticket Reloader test",
      message: "Tap the button to confirm replies work.",
      tags: ["white_check_mark"],
      actions: [replyAction("It works", ntfyReplyTopic, "TEST|assign")],
    });
    await updatePending((p) => {
      p.TEST = { ts: Date.now() };
    });
    await log("Test alert sent - tap the button on your phone");
    try {
      await startAlarm(["TEST"]);
    } catch (e) {
      await log(`Alarm could not start (${e.message})`);
    }
    startFastPoll();
  } catch (e) {
    await log(`Test alert failed (${e.message})`);
  }
}

async function handleReply(text) {
  const [number, action] = text.split("|").map((x) => (x || "").trim());
  if (!number) return;

  // Only act on tickets we actually asked about, and only once
  const p = await updatePending((pend) => {
    const entry = pend[number];
    delete pend[number];
    return entry;
  });
  if (!p) return;

  await alarmResolve(number);

  if (number === "TEST") {
    await log("Phone reply received - buttons work");
    return;
  }

  if (action === "assign" || action === "route") {
    let tabId = p.tabId;
    if (!(await tabExists(tabId))) {
      const tab = await chrome.tabs.create({ url: p.url, active: false });
      tabId = tab.id;
    }
    // each runs on its own and logs its own result
    if (action === "assign") assignTicket(tabId, number);
    else routeTicket(tabId, number);
  } else {
    await log(`${number}: left as is - open in its tab`);
  }
}

// Ask ntfy for any button taps since the last check
let polling = false;
async function pollReplies() {
  if (polling) return;
  polling = true;
  try {
    const { ntfyReplyTopic, replySince } = await chrome.storage.local.get(["ntfyReplyTopic", "replySince"]);
    if (!ntfyReplyTopic) return;
    let res;
    try {
      res = await fetch(`https://ntfy.sh/${ntfyReplyTopic}/json?poll=1&since=${replySince || "all"}`);
    } catch {
      return; // network hiccup - next poll will retry
    }
    if (!res.ok) return;

    const events = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.event === "message");
    if (!events.length) return;

    await chrome.storage.local.set({ replySince: events[events.length - 1].id });
    for (const e of events) await handleReply(String(e.message || ""));
  } finally {
    polling = false;
  }
}

// After an alert goes out, check for the tap every ~6 s for 5 minutes
// (the 30-second alarm keeps checking after that)
let fastPolling = false;
async function startFastPoll() {
  if (fastPolling) return;
  fastPolling = true;
  const end = Date.now() + 5 * 60 * 1000;
  try {
    while (Date.now() < end) {
      const { pending = {} } = await chrome.storage.local.get("pending");
      if (!Object.keys(pending).length) break;
      await pollReplies();
      await sleep(6000);
    }
  } finally {
    fastPolling = false;
  }
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START") await startMonitoring(msg.name);
    if (msg.type === "STOP") await stopMonitoring();
    if (msg.type === "SCAN") await handleScan(msg.tickets || [], sender.tab && sender.tab.id);
    if (msg.type === "TEST_NTFY") await sendTest();
    if (msg.type === "STOP_ALARM") await stopAlarmSound();
    if (msg.type === "ENSURE_TOPICS") {
      const t = await ensureTopics();
      sendResponse({ ok: true, topic: t.ntfyTopic });
      return;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// ---------- 1-minute reload ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_STOP) {
    await stopAlarmSound();
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  const { running } = await chrome.storage.local.get("running");
  if (!running) return;

  await pollReplies();

  const tab = await getTrackedTab();
  if (tab) {
    await chrome.tabs.reload(tab.id);
  } else {
    await stopMonitoring("Ticket tab was closed - monitoring stopped");
  }
});

// Tab closed by user -> stop
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.session.get(TAB_KEY);
  if (data[TAB_KEY] !== tabId) return;
  await chrome.storage.session.remove(TAB_KEY);
  const { running } = await chrome.storage.local.get("running");
  if (running) await stopMonitoring("Ticket tab was closed - monitoring stopped");
});

// Browser restarted while monitoring was ON -> resume with a fresh baseline
chrome.runtime.onStartup.addListener(async () => {
  const { running } = await chrome.storage.local.get("running");
  if (running) {
    await chrome.storage.local.set({
      seen: [],
      baselined: false,
      pending: {},
      replySince: String(Math.floor(Date.now() / 1000)),
    });
    await openTabAndSchedule();
    await log("Browser restarted - monitoring resumed");
  }
});

chrome.runtime.onInstalled.addListener(() => { ensureTopics(); });
