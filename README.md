# RollWatch — Flip Alert

A small sensor pod in a chest pocket of a baby's onesie tells a laptop when it has been turned face down for a few seconds, and the laptop screen turns red and sounds an alarm.

> **Safety.** RollWatch was built and tested **on a doll only**. It is a position-awareness prototype, **not a medical device**. It does not monitor breathing, does not prevent SIDS, and must never be used on a real baby.

**Live page:** https://khoahonguyen0210.github.io/rollwatch/ (Chrome or Edge on a desktop)

<!-- TODO (SW-B, Task 5.2): add photo of pod + onesie + screen from hardware/photos/ -->
<!-- ![Pod in the onesie pocket next to the RollWatch screen](hardware/photos/demo.jpg) -->

## What the parent sees

| Screen | Meaning | Sound |
|---|---|---|
| **OK** (green) | pod is face up | off |
| **FLIPPED** (red) | pod has been face down for 3 s | repeating beep |
| after **ACK** | still red, sound stops; sounds again if still flipped 30 s later | off → on |
| **POD DISCONNECTED** (orange) | no data from the pod for 2 s; never shown as OK | repeating beep |

Every flip goes into an event log (start, end, duration, acknowledged), which can be exported as CSV. The page also counts flips and total time flipped. **Demo mode** shortens the 3 s confirm time to 1 s for live demos.

## Results (measured on a test doll)

<!-- TODO (Phase 4): copy measured numbers from docs/results.md. Do not fill in anything that was not measured. -->

| Test | What we did | Result |
|---|---|---|
| E1 Flip detection | 20 flips onto the stomach | _not measured yet_ |
| E2 False alerts | 20 wiggles on the back (arm lifts, gentle shakes, side tilts) | _not measured yet_ |
| E3 Alarm delay | 10 flips, stopwatch from flip to alarm | _not measured yet_ |
| E4 Disconnect | 5 USB unplugs, time to "POD DISCONNECTED" | _not measured yet_ |
| E5 Logic tests | `npm test` | all pass |

Full details: [docs/results.md](docs/results.md).

## How it works

```text
 ONESIE POD                         LAPTOP (Chrome)
┌────────────────────┐   USB     ┌──────────────────────────┐
│ IMU → ESP32-S3     │ ────────→ │ serial.js  read lines    │
│ decides OK/FLIPPED │  lines    │ logic.js   alarm + log   │
│ (speaker, Tier 2)  │           │ app.js     screen + sound│
└────────────────────┘           └──────────────────────────┘
```

1. The IMU sits flat in the pod with the chip facing away from the chest. It measures gravity along its Z axis: about **+1 g** when the doll is on its back and **−1 g** when it is face down.
2. The ESP32-S3 reads Z at 50 Hz and smooths it. If smoothed Z stays below **−0.7 g** for 3 s, the pod reports **FLIPPED**. It goes back to **OK** only when Z rises above **+0.7 g**. Anything in between (lying on a side) keeps the current state, so a side roll does not trigger an alarm.
3. Every 200 ms the pod sends a line over USB serial (115200 baud), e.g. `S,48210,FLIPPED,-0.97`.
4. The web page reads the lines with the Web Serial API and decides the screen, sound, ACK, disconnect alert and log. That logic lives in pure functions in [web/logic.js](web/logic.js), covered by [tests/logic.test.js](tests/logic.test.js).

## Wiring

| Part | Part pin | ESP32-S3 pin |
|---|---|---|
| IMU (MPU6050 / GY-521) | VCC | 3V3 |
| IMU | GND | GND |
| IMU | SDA | GPIO 8 |
| IMU | SCL | GPIO 9 |
| IMU | AD0 | GND (address 0x68) |
| Amp (Tier 2) | VIN | 5V |
| Amp | GND | GND |
| Amp | IN+ | GPIO 7 |
| Amp | IN− | GND |
| Speaker | + / − | amp OUT+ / OUT− |

## How to run it

**Page only (no hardware):** open the live page, expand **Test tools (fake pod)**, press **Start fake pod**, then use **On back / On stomach / On side / Unplug**.

**With the pod:**

1. Flash [firmware/pod/pod.ino](firmware/pod/pod.ino) to the ESP32-S3 with the Arduino IDE (ESP32 board support; enable "USB CDC On Boot" if Serial shows nothing).
2. Close the Arduino Serial Monitor.
3. Plug the pod into the laptop with a USB **data** cable.
4. Open the live page in Chrome or Edge, press **Connect pod** and pick the pod's port. (The click also lets the browser play sound.)

**Run locally:**

```bash
npx serve .          # or any static server, then open http://localhost:3000/web/
npm test             # logic tests (Node.js 20+)
```

## Limitations

- Tested only on a doll, with the pod held flat in a snug pocket. A real body moves, slouches and twists in ways a doll does not.
- The pod knows only which way the chest faces. It knows nothing about breathing, heart rate or the baby's health.
- The pod is tethered by a USB cable and the laptop must stay awake with the page open.
- If the pod rotates inside the pocket, the reading is wrong.

## What a real product would still need

- Wireless link with its own disconnect alarm
- Sealed pod too large to swallow, with no loose parts
- Non-removable rechargeable battery
- Washable, skin-safe casing
- Safety testing and regulatory review

## Credits

Built at HowdyHack by a team of four:

- **SW-A**: pod firmware, line format, serial reader
- **SW-B**: web page, alarm, ACK, log, export, README
- **HW-A**: wiring, speaker, cable and power
- **HW-B**: onesie pocket, doll, testing, demo station

All code was written with an AI assistant and reviewed, run and tested by the software members.

License: see [LICENSE](LICENSE).

---

Position awareness only. Not a medical device.
