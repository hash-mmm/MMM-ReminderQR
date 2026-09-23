/*
 * node_helper.js for MMM-ReminderQR
 *
 * Responsibilities:
 *  - Load the reminders file (JSON) from disk.
 *  - Every minute, check every reminder against its schedule
 *    (day pattern + time + validity window) and fire it at most
 *    once per matching period.
 *  - On fire: generate a one-time dismiss token + QR code (encoding
 *    a URL served by this same helper), push it to the front-end,
 *    and start looping the configured sound.
 *  - Expose an HTTP route (via MagicMirror's shared express app) that
 *    a phone hits after scanning the QR code, which stops the sound
 *    and tells the front-end to clear the effect.
 */

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const QRCode = require("qrcode");
const player = require("play-sound")({});

module.exports = NodeHelper.create({
  start: function () {
    this.config = null;
    this.reminders = [];
    this.active = {}; // token -> { reminder, playsDone, timer, soundProcess, dismissed }
    this.lastFired = {}; // reminder.id -> period key already fired, so we don't re-fire every minute
    this.schedulerInterval = null;
    this.routeRegistered = false;
    this.remindersFilePath = null;
    this.fileWatcher = null;
    this.fileWatchDebounce = null;
    console.log("[MMM-ReminderQR] node_helper started");
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "REMINDERQR_INIT") {
      this.config = payload;
      this.loadReminders();
      this.registerRoutes();
      this.startScheduler();
    }
  },

  // ---------- Setup ----------

  loadReminders: function () {
    const filePath = path.isAbsolute(this.config.remindersFile)
      ? this.config.remindersFile
      : path.join(this.getRootPath(), this.config.remindersFile);

    this.remindersFilePath = filePath;

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      this.reminders = JSON.parse(raw);
      console.log(`[MMM-ReminderQR] Loaded ${this.reminders.length} reminder(s) from ${filePath}`);
    } catch (err) {
      console.error(`[MMM-ReminderQR] Could not load reminders file (${filePath}):`, err.message);
      this.reminders = [];
    }
    this.sendSocketNotification("REMINDER_SUMMARY", this.buildSummary());
    this.watchRemindersFile();
  },

  watchRemindersFile: function () {
    if (this.fileWatcher || !this.remindersFilePath) return;

    const startWatch = () => {
      try {
        this.fileWatcher = fs.watch(this.remindersFilePath, { persistent: false }, (eventType) => {
          if (this.fileWatchDebounce) clearTimeout(this.fileWatchDebounce);
          this.fileWatchDebounce = setTimeout(() => {
            this.fileWatchDebounce = null;
            if (eventType === "rename") {
              // Some editors write atomically (rename temp → target); recreate watcher.
              this.fileWatcher.close();
              this.fileWatcher = null;
              setTimeout(startWatch, 500);
            }
            try {
              const raw = fs.readFileSync(this.remindersFilePath, "utf8");
              this.reminders = JSON.parse(raw);
              console.log(`[MMM-ReminderQR] Reloaded ${this.reminders.length} reminder(s) from ${this.remindersFilePath}`);
            } catch (err) {
              console.error("[MMM-ReminderQR] Could not reload reminders file:", err.message);
              return;
            }
            this.sendSocketNotification("REMINDER_SUMMARY", this.buildSummary());
          }, 300);
        });
        console.log(`[MMM-ReminderQR] Watching ${this.remindersFilePath} for changes`);
      } catch (err) {
        console.error("[MMM-ReminderQR] Could not watch reminders file:", err.message);
      }
    };

    startWatch();
  },

  registerRoutes: function () {
    if (this.routeRegistered) return;

    this.expressApp.get("/MMM-ReminderQR/dismiss/:token", (req, res) => {
      const ok = this.dismiss(req.params.token);
      res.set("Content-Type", "text/html");
      res.send(
        ok
          ? "<html><body style='font-family:sans-serif;text-align:center;padding-top:20%;background:#111;color:#fff;'><h1>Dismissed &#10003;</h1><p>You can close this tab.</p></body></html>"
          : "<html><body style='font-family:sans-serif;text-align:center;padding-top:20%;background:#111;color:#fff;'><h1>Nothing to dismiss</h1><p>This reminder is no longer active (maybe it was already dismissed).</p></body></html>"
      );
    });

    this.routeRegistered = true;
  },

  // ---------- Scheduling ----------

  startScheduler: function () {
    if (this.schedulerInterval) return;

    this.tick(); // catch anything matching right now
    const msToNextMinute = 60000 - (Date.now() % 60000);
    setTimeout(() => {
      this.tick();
      this.schedulerInterval = setInterval(() => this.tick(), 60000);
    }, msToNextMinute);
  },

  tick: function () {
    const now = new Date();
    this.reminders.forEach((reminder) => {
      if (this.shouldFire(reminder, now)) {
        this.fire(reminder, now);
      }
    });
    this.sendSocketNotification("REMINDER_SUMMARY", this.buildSummary());
  },

  shouldFire: function (reminder, now) {
    if (!this.withinValidity(reminder, now)) return false;
    if (!this.matchesTime(reminder, now)) return false;
    if (!this.matchesDay(reminder, now)) return false;

    const key = this.periodKey(reminder, now);
    if (this.lastFired[reminder.id] === key) return false; // already fired this period
    return true;
  },

  withinValidity: function (reminder, now) {
    if (!reminder.validity) return true;
    const today = this.dateOnly(now);
    if (reminder.validity.start && today < reminder.validity.start) return false;
    if (reminder.validity.end && today > reminder.validity.end) return false;
    return true;
  },

  // Accepts "8:24 PM", "10:00 AM", "22:00", "08:30" — returns [hours24, minutes].
  parseTime: function (timeStr) {
    const s = (timeStr || "12:00 AM").trim();
    const match = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const pm = match[3].toLowerCase() === "pm";
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
      return [h, m];
    }
    // Fall back to 24-hour "HH:MM"
    const [h, m] = s.split(":").map(Number);
    return [h, m];
  },

  matchesTime: function (reminder, now) {
    const [h, m] = this.parseTime(reminder.time);
    return now.getHours() === h && now.getMinutes() === m;
  },

  // Supported "day" field formats:
  //   "daily"
  //   "weekly:MON,WED,FRI"   (3-letter day codes, SUN..SAT)
  //   "monthly:15"           (day of month) or "monthly:last"
  //   "yearly:MM-DD"
  //   "once:YYYY-MM-DD"
  matchesDay: function (reminder, now) {
    const field = (reminder.day || "daily").trim();

    if (field === "daily") return true;

    if (field.startsWith("weekly:")) {
      const wanted = field.split(":")[1].split(",").map((d) => d.trim().toUpperCase());
      const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      return wanted.includes(names[now.getDay()]);
    }

    if (field.startsWith("monthly:")) {
      const spec = field.split(":")[1].trim().toLowerCase();
      if (spec === "last") {
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        return now.getDate() === lastDayOfMonth;
      }
      return now.getDate() === parseInt(spec, 10);
    }

    if (field.startsWith("yearly:")) {
      const [mm, dd] = field.split(":")[1].trim().split("-").map(Number);
      return now.getMonth() + 1 === mm && now.getDate() === dd;
    }

    if (field.startsWith("once:")) {
      return this.dateOnly(now) === field.split(":")[1].trim();
    }

    console.warn(`[MMM-ReminderQR] Unknown "day" pattern "${field}" on reminder ${reminder.id}`);
    return false;
  },

  // A key that uniquely identifies "this occurrence" so a reminder fires
  // once per matching period rather than every minute the clock matches.
  periodKey: function (reminder, now) {
    const field = reminder.day || "daily";
    if (field.startsWith("monthly:")) return `${now.getFullYear()}-${now.getMonth()}`;
    return this.dateOnly(now); // daily / weekly / yearly / once all fire at most once a day
  },

  dateOnly: function (d) {
    return d.toISOString().slice(0, 10);
  },

  // ---------- Summary ----------

  getNextOccurrence: function (reminder, now) {
    const [h, m] = this.parseTime(reminder.time);
    for (let i = 0; i <= 400; i++) {
      const candidate = new Date(now.getTime());
      candidate.setDate(candidate.getDate() + i);
      candidate.setHours(h, m, 0, 0);
      if (candidate <= now) continue;
      if (!this.withinValidity(reminder, candidate)) continue;
      if (this.matchesDay(reminder, candidate)) return candidate;
    }
    return null;
  },

  describeDay: function (reminder) {
    const field = (reminder.day || "daily").trim();
    if (field === "daily") return "Daily";
    if (field.startsWith("weekly:")) {
      const days = field.split(":")[1].split(",").map((d) => d.trim());
      return "Weekly: " + days.join(", ");
    }
    if (field.startsWith("monthly:")) {
      const spec = field.split(":")[1].trim().toLowerCase();
      if (spec === "last") return "Monthly (last day)";
      const n = parseInt(spec, 10);
      const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
      return `Monthly (${n}${suffix})`;
    }
    if (field.startsWith("yearly:")) {
      const [mm, dd] = field.split(":")[1].trim().split("-").map(Number);
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `Yearly (${months[mm - 1]} ${dd})`;
    }
    if (field.startsWith("once:")) return "One-time";
    return field;
  },

  buildSummary: function () {
    const now = new Date();
    const items = [];
    for (const r of this.reminders) {
      const next = this.getNextOccurrence(r, now);
      if (next) {
        items.push({ id: r.id, title: r.title, next: next.toISOString(), pattern: this.describeDay(r) });
      }
    }
    return items.sort((a, b) => a.next.localeCompare(b.next));
  },

  // ---------- Firing ----------

  fire: function (reminder, now) {
    this.lastFired[reminder.id] = this.periodKey(reminder, now);

    const token = crypto.randomBytes(8).toString("hex");
    const port = this.config.serverPort || 8080;
    const host = this.config.serverHost || this.getLanAddress();
    const dismissUrl = `http://${host}:${port}/MMM-ReminderQR/dismiss/${token}`;

    QRCode.toDataURL(dismissUrl, { margin: 1, width: 260 }, (err, dataUrl) => {
      if (err) {
        console.error("[MMM-ReminderQR] QR generation failed:", err.message);
        return;
      }

      this.active[token] = {
        reminder,
        playsDone: 0,
        timer: null,
        soundProcess: null,
        dismissed: false,
      };

      this.sendSocketNotification("REMINDER_TRIGGERED", {
        token,
        id: reminder.id,
        title: reminder.title,
        effect: reminder.effect || this.config.defaultEffect || "flash",
        qrDataUrl: dataUrl,
      });

      this.playSoundLoop(token);
    });
  },

  playSoundLoop: function (token) {
    const active = this.active[token];
    if (!active || active.dismissed) return;

    const reminder = active.reminder;
    const soundFile = reminder.sound || this.config.defaultSound;

    if (!soundFile) {
      // No sound configured on the reminder or as a module default: silent reminder (effect + QR only).
      return;
    }

    const soundPath = path.isAbsolute(soundFile)
      ? soundFile
      : path.join(this.getRootPath(), this.config.soundsDir || "sounds", soundFile);

    active.soundProcess = player.play(soundPath, (err) => {
      if (!this.active[token] || this.active[token].dismissed) return; // dismissed while playing

      if (err) {
        console.error(`[MMM-ReminderQR] Error playing "${soundPath}" for ${reminder.id}:`, err.message || err);
      }

      active.playsDone += 1;

      const repeat = reminder.soundRepeat !== undefined ? reminder.soundRepeat : this.config.defaultSoundRepeat;
      const untilDismissed = repeat === "untilDismissed" || repeat === "till dismissed" || repeat === "till_dismissed";
      const maxPlays = untilDismissed ? Infinity : parseInt(repeat, 10) || 1;

      if (active.playsDone < maxPlays) {
        active.timer = setTimeout(() => this.playSoundLoop(token), 2000);
      }
    });
  },

  dismiss: function (token) {
    const active = this.active[token];
    if (!active || active.dismissed) return false;

    active.dismissed = true;
    if (active.timer) clearTimeout(active.timer);
    if (active.soundProcess && typeof active.soundProcess.kill === "function") {
      try {
        active.soundProcess.kill();
      } catch (e) {
        // process may have already exited between plays; safe to ignore
      }
    }

    this.sendSocketNotification("REMINDER_DISMISSED", { token, id: active.reminder.id });
    delete this.active[token];
    return true;
  },

  // MagicMirror sets `global.root_path` at startup to its own install
  // directory (e.g. ~/MagicMirror). We use that so `soundsDir` in the config
  // is relative to the MagicMirror root rather than this module's folder.
  // Falls back to walking up two levels from this file (modules/MMM-ReminderQR)
  // in case root_path isn't set for some reason.
  getRootPath: function () {
    return global.root_path || path.join(__dirname, "..", "..");
  },

  getLanAddress: function () {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
    return "localhost";
  },
});
