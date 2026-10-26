// Runs inside every frame on gsk.service-now.com.
// The ticket list lives in the "gsft_main" iframe, whose page is incident_list.do.
// Every other frame/page exits immediately.
(function () {
  if (!location.pathname.endsWith("incident_list.do")) return;

  // Small delay so the list finishes rendering after load
  setTimeout(() => {
    const tickets = [];
    const found = new Set();

    document.querySelectorAll("tr.list_row a.linked.formlink").forEach((a) => {
      const number = a.textContent.trim();
      if (!/^INC\d+$/.test(number) || found.has(number)) return;
      found.add(number);
      tickets.push({ number, url: a.href });
    });

    // Sent even when the list is empty, so the background knows the scan happened
    chrome.runtime.sendMessage({ type: "SCAN", tickets });
  }, 1500);
})();
