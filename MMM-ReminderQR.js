/* global Module */

/*
 * MMM-ReminderQR
 *
 * Displays a full-screen-ish alert card with a title, an applied
 * visual "effect" class on <body>, and a QR code. The reminder stays
 * active (sound repeating, effect running) until someone scans the
 * QR code with their phone, which hits a dismiss URL served by
 * node_helper.js.
 */
Module.register("MMM-ReminderQR", {
  defaults: {
    remindersFile: "modules/MMM-ReminderQR/reminders.json", // relative to the MagicMirror root, or an absolute path
    soundsDir: "sounds", // relative to the MagicMirror root directory, or an absolute path
    defaultSound: null, // filename or absolute path used when a reminder doesn't specify its own "sound"
    defaultEffect: "flash", // effect used when a reminder doesn't specify its own "effect"
    defaultSoundRepeat: 1, // number, or "untilDismissed", used when a reminder doesn't specify its own "soundRepeat"
    serverPort: 8080, // the port your MagicMirror server is reachable on from your phone
    serverHost: null, // set this to your mirror's LAN IP if auto-detection picks the wrong interface
    showSummary: true, // show upcoming reminders when no alert is active
    title: "Reminders", // module header; set to "" to hide
  },

  requiresVersion: "2.1.0",

  getHeader: function () {
    return this.config.title;
  },

  start: function () {
    this.activeReminder = null;
    this.summary = [];
    this.regionWidth = 0;
    this.sendSocketNotification("REMINDERQR_INIT", this.config);
    // Re-render 2 s after startup so we pick up the final region width once all
    // sibling modules have rendered and established their sizes.
    setTimeout(() => { if (!this.activeReminder) this.updateDom(0); }, 2000);
  },

  getStyles: function () {
    return ["MMM-ReminderQR.css"];
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "REMINDER_TRIGGERED") {
      this.activeReminder = payload;
      this.applyEffect(payload.effect);
      this.updateDom(200);
    }

    if (notification === "REMINDER_DISMISSED") {
      if (this.activeReminder && this.activeReminder.token === payload.token) {
        this.clearEffect();
        this.activeReminder = null;
        this.updateDom(200);
      }
    }

    if (notification === "REMINDER_SUMMARY") {
      this.summary = payload;
      if (!this.activeReminder) this.updateDom(200);
    }
  },

  applyEffect: function (effect) {
    this.clearEffect();
    document.body.classList.add(`mmm-reminderqr-${effect}`);
  },

  clearEffect: function () {
    const effects = ["flash", "shake", "pulse", "zoom", "invert", "strobe", "alarm", "glitch", "rainbow"];
    effects.forEach((e) => document.body.classList.remove(`mmm-reminderqr-${e}`));
  },

  formatNextDate: function (isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const h = date.getHours();
    const m = date.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    const timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (date.toDateString() === now.toDateString()) return `Today ${timeStr}`;
    if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${timeStr}`;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()} ${timeStr}`;
  },

  getDom: function () {
    // Measure the region width on every render and pin our module container to it.
    // No need to hide ourselves: on the first call our container is empty so it
    // contributes ~0; on later calls we've already constrained ourselves to the same
    // width so the measurement is stable. The 2 s deferred updateDom in start() ensures
    // we sync to the final region width after all sibling modules have loaded.
    const moduleEl = document.getElementById(this.identifier);
    if (moduleEl) {
      const regionEl = moduleEl.parentElement && moduleEl.parentElement.parentElement;
      if (regionEl && regionEl.offsetWidth > 0) {
        this.regionWidth = regionEl.offsetWidth;
      }
      if (this.regionWidth > 0) {
        moduleEl.style.width = this.regionWidth + "px";
        moduleEl.style.overflow = "hidden";
      }
    }

    const wrapper = document.createElement("div");
    wrapper.className = "reminderqr-wrapper";

    if (!this.activeReminder) {
      if (this.config.showSummary && this.summary.length > 0) {
        // table-layout:fixed with an inline width so the table never expands the region.
        // We use 100% of the module container (which is pinned to regionWidth above)
        // so rows always stretch edge-to-edge within the region.
        const list = document.createElement("table");
        list.className = "reminderqr-summary";
        list.style.tableLayout = "fixed";
        list.style.width = "100%";
        list.style.borderSpacing = "0";
        list.style.borderCollapse = "collapse";

        const colgroup = document.createElement("colgroup");
        [55, 45].forEach(function (pct) {
          const col = document.createElement("col");
          col.style.width = pct + "%";
          colgroup.appendChild(col);
        });
        list.appendChild(colgroup);

        this.summary.forEach((item) => {
          const row = document.createElement("tr");
          row.className = "reminderqr-summary-row";

          const tdTitle = document.createElement("td");
          tdTitle.className = "reminderqr-summary-title";
          tdTitle.textContent = item.title;

          const tdWhen = document.createElement("td");
          tdWhen.className = "reminderqr-summary-when";

          const nextEl = document.createElement("span");
          nextEl.className = "reminderqr-summary-next";
          nextEl.textContent = this.formatNextDate(item.next);

          const sepEl = document.createElement("span");
          sepEl.className = "reminderqr-summary-sep";
          sepEl.textContent = " · ";

          const patternEl = document.createElement("span");
          patternEl.className = "reminderqr-summary-pattern";
          patternEl.textContent = item.pattern;

          tdWhen.appendChild(nextEl);
          tdWhen.appendChild(sepEl);
          tdWhen.appendChild(patternEl);

          row.appendChild(tdTitle);
          row.appendChild(tdWhen);
          list.appendChild(row);
        });
        wrapper.appendChild(list);
      }
      return wrapper;
    }

    const card = document.createElement("div");
    card.className = "reminderqr-card";
    // Pin the card to the region's natural width (measured on summary load) so the
    // QR code and title never push the region wider than other modules set it.
    if (this.regionWidth > 0) {
      card.style.width = this.regionWidth + "px";
      card.style.boxSizing = "border-box";
    }

    const title = document.createElement("div");
    title.className = "reminderqr-title";
    title.innerHTML = this.activeReminder.title;
    card.appendChild(title);

    const instructions = document.createElement("div");
    instructions.className = "reminderqr-instructions";
    instructions.innerHTML = "Scan with your phone to dismiss";
    card.appendChild(instructions);

    const img = document.createElement("img");
    img.className = "reminderqr-qr";
    img.src = this.activeReminder.qrDataUrl;
    card.appendChild(img);

    wrapper.appendChild(card);
    return wrapper;
  },
});
