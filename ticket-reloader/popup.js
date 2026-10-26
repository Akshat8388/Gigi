const DEFAULT_NAME = "Akshat Bhardwaj";

const nameInput = document.getElementById("name");
const toggleBtn = document.getElementById("toggle");
const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const logList = document.getElementById("log");
const clearLink = document.getElementById("clear");

function render({ running, logs }) {
  toggleBtn.textContent = running ? "Stop Monitoring" : "Start Monitoring";
  toggleBtn.classList.toggle("stop", running);
  dot.classList.toggle("on", running);
  statusText.textContent = running ? "Running - reloading every 30 sec" : "Stopped";

  logList.innerHTML = "";
  if (!logs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No activity yet";
    logList.appendChild(li);
    return;
  }
  for (const entry of logs) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = new Date(entry.time).toLocaleTimeString();
    const m = document.createElement("span");
    m.textContent = entry.msg;
    li.append(t, m);
    logList.appendChild(li);
  }
}

async function refresh() {
  const { running = false, logs = [] } = await chrome.storage.local.get(["running", "logs"]);
  render({ running, logs });
}

async function init() {
  const { name = DEFAULT_NAME } = await chrome.storage.local.get("name");
  nameInput.value = name;
  await refresh();
}

// Save name as you type
nameInput.addEventListener("input", () => {
  chrome.storage.local.set({ name: nameInput.value });
});

// Start / Stop
toggleBtn.addEventListener("click", async () => {
  const { running = false } = await chrome.storage.local.get("running");
  if (running) {
    await chrome.runtime.sendMessage({ type: "STOP" });
  } else {
    const name = nameInput.value.trim() || DEFAULT_NAME;
    nameInput.value = name;
    await chrome.runtime.sendMessage({ type: "START", name });
  }
});

// Clear activity log
clearLink.addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ logs: [] });
});

// Live updates while popup is open
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") refresh();
});

// ---- phone alerts (ntfy) ----
const topicInput = document.getElementById("topic");
const copyBtn = document.getElementById("copy");
const testBtn = document.getElementById("test");

async function loadTopic() {
  const res = await chrome.runtime.sendMessage({ type: "ENSURE_TOPICS" });
  topicInput.value = (res && res.topic) || "";
}

copyBtn.addEventListener("click", () => {
  topicInput.select();
  document.execCommand("copy");
  copyBtn.textContent = "Copied";
  setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
});

testBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TEST_NTFY" });
});

loadTopic();
init();
