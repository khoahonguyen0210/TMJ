# RollWatch

A small motion sensor tells a laptop when it has been turned **face down** for 3 seconds. The laptop screen turns red and beeps until someone checks.

> **The hardware detects. The software understands.** Each night is recorded, the page turns it into a timeline and stats, and an AI can explain those stats in plain words.

The idea is a sensor in a baby's onesie pocket that warns a parent when the baby rolls onto their stomach. For this prototype we built the sensor board and the web page, and tested them by **flipping the bare board by hand**. We did not test it on a doll, in a onesie or on a person.

> **Safety.** RollWatch is a hackathon prototype that only knows which way the board faces. It is **not a medical device**. It does not monitor breathing, does not prevent SIDS and must never be used on a real baby.

## What you see

| Screen | When | Sound |
|---|---|---|
| **All good** (green) | the board is not face down | off |
| **On side** (yellow) | lying on its side for 3 s, not an alarm | off |
| **Likely to roll** (yellow) | on its side and moving for 2 s (a simple rule, not AI) | one soft beep |
| **Flipped** (red) | the board has been face down for 3 s | beeps |
| after **Silence alarm** | still red, sound stops, beeps again if still flipped 30 s later | off, then on |
| **No signal** (orange) | no data from the sensor for 2 s | beeps |

Under the status, a drawing of the board tilts the same way the real one does, and a bar shows where it is between **Face up**, **On side** and **Face down**.

**Fast alert** shortens the 3 s wait to 1 s for demos.

### When nobody answers

- **Gets louder:** an alarm nobody silences beeps louder and faster after 30 s. After 60 s it goes to maximum volume and a **NO RESPONSE** banner appears. Pressing Silence resets it.
- **Flashes the screen:** during an alarm the whole screen pulses red once a second (never faster, which keeps it safe for people sensitive to flashing). It can be switched off under **Flash the screen**.
- **Reconnects by itself:** if the USB cable drops, the page keeps alarming **No signal** and tries to reopen the same port every 2 s. It never shows "All good" until real data comes back.

### Phone notifications

The page can send alarms to a phone through [ntfy](https://ntfy.sh). There is no app to build: install the free **ntfy** app, then on the page open **Phone notifications**, press **New** to get a random topic, subscribe to that topic in the app, and switch **Send notifications** on.

| What happened | Phone gets | Priority |
|---|---|---|
| Flipped | "Baby rolled onto stomach" + **Acknowledge** button | high |
| No answer for 30 s / 60 s | "Still on stomach – no response 30 s" / "NO RESPONSE – 60 s" + Acknowledge | urgent |
| No signal | "Monitor offline" + Acknowledge | high |
| Silenced (laptop or phone) | "Acknowledged from phone after 12 s" | low |
| Back face up | "Back on back after 1 min 20 s" | low |
| Reconnected | "Monitor reconnected" | low |
| End night (if a summary was made) | the AI summary, labeled AI-written | normal |
| On side / likely to roll | nothing, to avoid spam | – |

- **Acknowledge on the phone** silences the laptop too, and the night log records where it was silenced from and how long it took.
- **Laptop sound** can be Loud, Soft or Off. In real use the phone is the main alarm; the screen still turns red and flashes in every setting.
- A failed push shows a message on the page and never delays the laptop alarm. Pushes from the simulator start with `[Simulator]`.
- Anyone who knows the topic can read it, so pick a random one and keep it to yourself. Messages carry no names or personal data.

### Night report

Everything from Connect until **End night** (or closing the page) is one night. It is saved in the browser and shows:

- a timeline of the night (not flipped / on side / flipped / no signal)
- flips, longest flip, total time face down, average time until someone pressed Silence
- early warnings, and how many were followed by a flip within 60 s
- flips per hour (chart)
- every event, exportable as CSV

**Print report** makes a one-page morning report (timeline, stats, chart, events, the AI summary if you made one, and the safety note). Choose "Save as PDF" in the print dialog to share it.

Pick an older night from the list to look back. **Sample night** is made-up data for trying the report without hardware; it and any night recorded with the simulator are labeled **Simulated demo data**.

### Ask about the night (AI)

**Summarize this night** writes 3–4 plain sentences. You can also type a question, or tap one of the suggestions ("When did the most rolls happen?", "How fast did we respond?", "How did tonight compare to last night?").

- The page computes every number. The AI only gets those numbers and the event list, never raw sensor data, and is told to use only them.
- It gives no medical advice; for health questions it says to ask a pediatrician.
- Every answer is labeled **AI-written from your log**.
- **Ask by voice:** tap the button, speak a question, and hear the answer read out. **Read summary aloud** reads the night summary. Uses the browser's speech recognition (Chrome or Edge, needs internet). Voice never touches the alarms.
- It uses Claude (`claude-opus-5-5`) called straight from the browser. Paste your own Anthropic API key under **AI settings**; it stays in that browser tab (sessionStorage) and is never saved in the code. The rest of the page works without a key.

### Trends

Once you have saved 2 or more nights, **Trends** shows each night's flips, longest flip, average time to silence and restless minutes, with the change from the night before. **Explain the trend** asks the AI to put those changes into words. Simulated nights are left out unless you tick the box.

### Activity model

A small k-nearest-neighbours model (k = 5, plain JavaScript) trained on our own labeled recordings of the board. It sorts every 2 seconds into **Still**, **Restless** or **Carried** and shows a row under the night timeline. **It never changes the alarms**; those stay rule-based.

- Features per 2 s window: mean z, mean x, mean motion, max motion, z range.
- Training data: hold **Still / Restless / Carried** in Label mode while moving the real board, about 2 minutes each, in 2 separate sessions. Export to `web/model/activity-data.json`.
- Evaluation: train on session 1, test on session 2, then swap, compared with a simple rule (motion > 0.05 → restless). `npm run eval-activity` prints accuracy and confusion tables from the real data.

## How it works

```text
 SENSOR BOARD                         LAPTOP (Chrome or Edge)
┌──────────────────────┐   USB     ┌────────────────────────────┐
│ MPU6050 → Arduino    │ ────────→ │ serial.js  reads the lines │
│ decides OK / FLIPPED │  5 lines  │ logic.js   alarm + side    │
│ measures x + motion  │  per sec  │ analytics.js  night stats  │
│                      │           │ ai.js      words (Claude)  │
│                      │           │ notify.js  phone (ntfy)    │
│                      │           │ app.js     screen + sound  │
└──────────────────────┘           └────────────────────────────┘
```

1. **Which way is it facing?** The MPU6050 measures how much of gravity points out of the chip's face. We call that number **z**:

   | Board | z |
   |---|---|
   | chip facing up | about +1 |
   | on its side | about 0 |
   | chip facing down | about −1 |

   The page turns z into a tilt angle: 0° is face up, 90° is on its side, 180° is face down.

2. **When is it "flipped"?** The Arduino reads z 50 times a second and smooths it. If z stays below **−0.7** (tilted more than about 134°) for 3 s, the board is **FLIPPED**. It goes back to **OK** only when z rises above **+0.7** (less than about 46°). Lying on a side keeps whatever state it was in, so tipping over sideways never sets off the alarm.

3. **Sending it to the laptop.** Every 200 ms the board sends one text line over USB, for example `S,48210,OK,0.03,0.98,0.07`: time in ms, state, z, then **x** (gravity along the chip's X axis, about ±1 when the board lies on its side) and **motion** (how much it is being moved over the last second, 0 = still). Older firmware sends only the first four; the page accepts both.

4. **On its side?** The page shows **On side** when |x| stays above **0.7** for 3 s, and **Likely to roll** when it is on its side and motion stays above **0.05** for 2 s. Flipped always wins. `MOTION_T` (0.05) is a tuning value in [web/config.js](web/config.js): set it once by comparing a still board with a moving one.

5. **The page.** It reads the lines with the Web Serial API and decides the screen, sound, silence and no-signal alarm. The rules are plain functions in [web/logic.js](web/logic.js), the night stats in [web/analytics.js](web/analytics.js), both tested in [tests/](tests/).

## Hardware

- Arduino Uno or Nano (the code also builds for an ESP32-S3)
- MPU6050 breakout (GY-521)
- USB **data** cable
- Optional: small amplifier and speaker for a beep on the board itself

| MPU6050 pin | Uno / Nano | ESP32-S3 |
|---|---|---|
| VCC | 5V | 3V3 |
| GND | GND | GND |
| SDA | A4 | GPIO 8 |
| SCL | A5 | GPIO 9 |
| AD0 | GND (address 0x68) | GND |

Optional speaker: amplifier IN+ to D7 (GPIO 7 on ESP32-S3), IN− to GND.

Our MPU6050 read about 0.48 too high on z, so the firmware subtracts that (`Z_OFFSET_G`). If you use a different chip, check it: z should read about +1 face up and −1 face down.

## How to run it

**Without hardware:** open the page, expand **No sensor? Use the simulator**, press **Start simulator**, then use **Face up / On side / Face down / Wiggle / Unplug**. Or pick **Sample night** in the Night report.

**With the board:**

1. Upload [firmware/i2c_scan/i2c_scan.ino](firmware/i2c_scan/i2c_scan.ino) first. The Serial Monitor should show a device at `0x68`.
2. Upload [firmware/pod/pod.ino](firmware/pod/pod.ino).
3. Close the Arduino Serial Monitor (only one program can use the port).
4. Open the page in Chrome or Edge, press **Connect sensor** and pick the board's port. This click also lets the browser play sound.

**Start the page locally:**

```bash
npx serve .     # then open http://localhost:3000/web/
npm test        # logic, analytics and model tests (Node.js 20+)
npm run eval-activity   # activity model results from web/model/activity-data.json
```

## Limitations

- Tested only by flipping the bare board by hand, never on a doll, in clothing or on a body.
- It only knows which way the board faces. It knows nothing about breathing, heart rate or health.
- The board needs a USB cable, and the laptop must stay awake with the page open.
- If the board turns inside a pocket, the reading is wrong.
- "Likely to roll" is a fixed rule (on its side + moving), not a trained model, and its threshold has not been tuned on real movement yet.
- The AI summary needs an internet connection and an API key, and can still word things badly; the numbers in the report are the source of truth.
- The activity model is only as good as our own recordings of one board, and has no results until those recordings exist.
- Voice questions send audio to the browser's speech service (Google in Chrome).
- Phone notifications only work while the laptop page is open and online.

## What a real product would still need

- Testing on a moving body, not just a hand-held board
- Wireless link with its own no-signal alarm
- Sealed case too large to swallow, with no loose parts
- Built-in rechargeable battery
- Washable, skin-safe casing
- Safety testing and regulatory review

## Credits

Built at HowdyHack by a team of four:

- **SW-A**: firmware, line format, serial reader
- **SW-B**: web page, alarm, history, export
- **HW-A**: wiring, speaker, cable and power
- **HW-B**: testing and demo station

All code was written with an AI assistant and reviewed, run and tested by the software members.

License: see [LICENSE](LICENSE).
