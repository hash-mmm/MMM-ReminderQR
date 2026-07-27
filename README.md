# MMM-ReminderQR

A [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) module for recurring
reminders. Each reminder is defined in a data file with a day pattern, a time, a sound,
how many times (or how long) the sound repeats, a visual "effect", and a validity
period. When a reminder fires, the mirror applies the effect, shows a QR code, and
loops the sound. The alert stays active until someone scans the QR code with their
phone — that's the dismiss action.

## How it works

1. `node_helper.js` reads your reminders file on startup and checks every reminder
   once a minute against the current time.
2. When a reminder's schedule matches, it:
   - Generates a one-time dismiss token and a QR code that encodes
     `http://<mirror-ip>:<port>/MMM-ReminderQR/dismiss/<token>`.
   - Sends the token, title, effect, and QR image to the front-end module.
   - Starts playing the configured sound on a loop.
3. The front-end module (`MMM-ReminderQR.js`) shows a card with the title and QR
   code, and applies the `effect` as a CSS animation class on `<body>`.
4. When someone scans the QR code with their phone (on the same network as the
   mirror) and it opens the dismiss URL, `node_helper.js` stops the sound and
   tells the front-end to clear the effect and hide the card.

Because the "scan" happens on the visitor's phone rather than a camera on the
mirror, no camera hardware is required — this reuses MagicMirror's built-in
web server, which is already reachable on your local network.

## Installation

```bash
cd ~/MagicMirror/modules
git clone <this-repo> MMM-ReminderQR
cd MMM-ReminderQR
npm install
```

`npm install` pulls in two dependencies:
- [`qrcode`](https://www.npmjs.com/package/qrcode) — generates the QR code image.
- [`play-sound`](https://www.npmjs.com/package/play-sound) — shells out to a local
  audio player. On Linux, install `mpg123` or `mplayer`; on macOS, `afplay` is used
  automatically; on Windows it uses the built-in Media Player.

Create a `sounds/` folder **at the root of your MagicMirror install** (i.e.
`~/MagicMirror/sounds/`, next to `config/` and `modules/`) and put your audio
files (mp3/wav) there — this module doesn't ship its own `sounds/` folder, so
you'll need to create it. Alternatively, point `soundsDir` at wherever your
sound files already live, or set `sound`/`defaultSound` to an absolute path
and skip `soundsDir` entirely.

## Configuration

Add to `config/config.js`:

```js
{
  module: "MMM-ReminderQR",
  position: "top_center",
  config: {
    remindersFile: "modules/MMM-ReminderQR/reminders.json", // relative to the MagicMirror root directory, or absolute
    soundsDir: "sounds",             // relative to the MagicMirror root directory, or absolute
    defaultSound: "chime.mp3",       // used when a reminder doesn't specify its own "sound"
    defaultEffect: "flash",          // used when a reminder doesn't specify its own "effect"
    defaultSoundRepeat: 1,           // number, or "untilDismissed", used when a reminder doesn't specify its own "soundRepeat"
    serverPort: 8080,                // the port your MagicMirror is served on
    serverHost: null,                // set explicitly if auto-detected LAN IP is wrong
    showSummary: true,               // show upcoming reminders when no alert is active
    title: "Reminders",              // module header title; set to "" to hide
  },
},
```

`serverHost` matters: your phone has to be able to reach the mirror at
`http://<serverHost>:<serverPort>/...`, so both devices need to be on the same
network, and the mirror's server needs to be reachable (not just `localhost`).
If auto-detection picks the wrong network interface, set `serverHost` to the
mirror's LAN IP manually.

## Reminders file format

The reminders file (set via `remindersFile` in config) is a JSON array of reminder objects.
The path is relative to the **MagicMirror root directory** (e.g. `~/MagicMirror/`), or you
can supply an absolute path. The default points to the file bundled with this module:
`modules/MMM-ReminderQR/reminders.json`. A common alternative is to keep it alongside
your mirror config: `"remindersFile": "config/reminders.json"`.

```json
{
  "id": "morning-meds",
  "title": "Take morning medication",
  "day": "daily",
  "time": "08:00 PM",
  "sound": "alarm.mp3",
  "soundRepeat": "untilDismissed",
  "effect": "flash",
  "validity": { "start": "2026-01-01", "end": "2026-12-31" }
}
```

| Field         | Description |
|---------------|-------------|
| `id`          | Unique string identifier for the reminder. |
| `title`       | Text shown on the alert card. |
| `day`         | Recurrence pattern (see below). |
| `time`        | Time at which the reminder fires. Accepts 12-hour (`"10:00 PM"`, `"8:30 AM"`) or 24-hour (`"22:00"`) format. |
| `sound`       | Optional. Filename inside `soundsDir` (resolved relative to the MagicMirror root directory), or an absolute path. If omitted, falls back to the module's `defaultSound` config option; if that's also unset, the reminder is silent (effect + QR code only, no audio). |
| `soundRepeat` | Optional. A number of times to play the sound, or the string `"untilDismissed"`. If omitted, falls back to the module's `defaultSoundRepeat` config option (`1` by default). |
| `effect`      | Optional. One of the built-in effect names (see below). If omitted, falls back to the module's `defaultEffect` config option (`flash` by default). |
| `validity`    | `{ "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }` — the reminder is ignored outside this window. |

### `effect` values

| Effect    | Description |
|-----------|-------------|
| `flash`   | Screen pulses red at 1s intervals. |
| `shake`   | Screen shakes horizontally at 0.4s intervals. |
| `pulse`   | Screen brightness pulses brighter at 1.2s intervals. |
| `zoom`    | Screen gently scales in and out at 1.5s intervals. |
| `invert`  | Colors flip between normal and fully inverted at 1s intervals. |
| `strobe`  | Rapid white flashes every 120ms — very intense. |
| `alarm`   | Aggressive red flash combined with a hard left/right shake every 250ms. |
| `glitch`  | Digital distortion: skew, translate, and hue-rotate cycling — unsettling. |
| `rainbow` | Continuous hue rotation through all colors with a brightness boost. |

### `day` patterns

| Pattern              | Meaning |
|----------------------|---------|
| `daily`               | Every day. |
| `weekly:MON,WED,FRI`  | On the listed days (3-letter codes, `SUN`..`SAT`). |
| `monthly:15`          | On the 15th of every month. |
| `monthly:last`        | On the last day of every month. |
| `yearly:06-14`        | Every year on June 14th. |
| `once:2026-08-01`     | A single date, never repeats. |

A reminder fires at most once per matching period (e.g. a `monthly:1` reminder
fires once on the 1st, not once per minute all day) — the helper tracks the
last period it fired in memory.

## Upcoming reminders summary

When no reminder is active, the module displays a table of all upcoming reminders sorted
by their next fire time. Each row shows the reminder title, the next trigger time
("Today 22:00", "Tomorrow 08:00", or a short date), and the recurrence pattern.

Set `showSummary: false` in config to disable this and keep the module invisible when idle.

Reminders with no future occurrence (expired `validity` window, or a `once` date that has
passed) are automatically excluded from the table.

## Adding a custom effect

Effects are CSS animation classes applied to `<body>` while a reminder is active
(`mmm-reminderqr-<effect>`, defined in `MMM-ReminderQR.css`). To add one:

1. Add a `@keyframes` block and a `.mmm-reminderqr-<name>` rule to `MMM-ReminderQR.css`.
2. Add `<name>` to the `effects` array in the `clearEffect` function in `MMM-ReminderQR.js` so it gets cleaned up on dismiss.
3. Use `<name>` as the `effect` value in your reminders file.

## Notes and limitations

- The scheduler checks once a minute, so reminders fire on the minute, not to
  the second.
- State (which reminders have already fired) is kept in memory — it resets if
  MagicMirror restarts. A reminder whose time already passed today won't
  re-fire until its next scheduled occurrence.
- `soundRepeat: "untilDismissed"` will loop the sound indefinitely (with a
  short pause between plays) until the QR code is scanned — make sure the
  sound isn't something that will upset the household at 3am on a bad day.
- This module doesn't do anything with a camera on the mirror; "scanning" the
  QR code is entirely on the visitor's phone.
