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

### Night report

Everything from Connect until **End night** (or closing the page) is one night. It is saved in the browser and shows:

- a timeline of the night (not flipped / on side / flipped / no signal)
- flips, longest flip, total time face down, average time until someone pressed Silence
- early warnings, and how many were followed by a flip within 60 s
- flips per hour (chart)
- every event, exportable as CSV

Pick an older night from the list to look back. **Sample night** is made-up data for trying the report without hardware; it and any night recorded with the simulator are labeled **Simulated demo data**.

### Ask about the night (AI)

**Summarize this night** writes 3–4 plain sentences. You can also type a question, or tap one of the suggestions ("When did the most rolls happen?", "How fast did we respond?", "How did tonight compare to last night?").

- The page computes every number. The AI only gets those numbers and the event list, never raw sensor data, and is told to use only them.
- It gives no medical advice; for health questions it says to ask a pediatrician.
- Every answer is labeled **AI-written from your log**.
- It uses Claude (`claude-opus-5-5`) called straight from the browser. Paste your own Anthropic API key under **AI settings**; it stays in that browser tab (sessionStorage) and is never saved in the code. The rest of the page works without a key.

## How it works

```text
 SENSOR BOARD                         LAPTOP (Chrome or Edge)
┌──────────────────────┐   USB     ┌────────────────────────────┐
│ MPU6050 → Arduino    │ ────────→ │ serial.js  reads the lines │
│ decides OK / FLIPPED │  5 lines  │ logic.js   alarm + side    │
│ measures x + motion  │  per sec  │ analytics.js  night stats  │
│                      │           │ ai.js      words (Claude)  │
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
npm test        # logic tests (Node.js 20+)
```

## Testing so far

We tested by holding the bare board and flipping it on a desk. Numbers will go in [docs/results.md](docs/results.md) once measured.

| Test | What we do | Result |
|---|---|---|
| Flip detection | flip the board face down 20 times | _not measured yet_ |
| False alerts | tilt and shake it 20 times without turning it face down | _not measured yet_ |
| Alarm delay | 10 flips, stopwatch from flip to alarm | _not measured yet_ |
| Unplug | pull the USB cable 5 times, time to "No signal" | _not measured yet_ |
| Early warning | 10 slow rolls through the side onto the face; 10 still side-lying periods | _not measured yet_ |
| AI faithfulness | 5 summaries + 5 questions, every number checked against the report | _not measured yet_ |
| Logic and analytics tests | `npm test` | 50 / 50 pass |

## Limitations

- Tested only by flipping the bare board by hand, never on a doll, in clothing or on a body.
- It only knows which way the board faces. It knows nothing about breathing, heart rate or health.
- The board needs a USB cable, and the laptop must stay awake with the page open.
- If the board turns inside a pocket, the reading is wrong.
- "Likely to roll" is a fixed rule (on its side + moving), not a trained model, and its threshold has not been tuned on real movement yet.
- The AI summary needs an internet connection and an API key, and can still word things badly; the numbers in the report are the source of truth.

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
