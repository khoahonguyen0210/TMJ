# RollWatch

A small motion sensor tells a laptop when it has been turned **face down** for 3 seconds. The laptop screen turns red and beeps until someone checks.

The idea is a sensor in a baby's onesie pocket that warns a parent when the baby rolls onto their stomach. For this prototype we built the sensor board and the web page, and tested them by **flipping the bare board by hand**. We did not test it on a doll, in a onesie or on a person.

> **Safety.** RollWatch is a hackathon prototype that only knows which way the board faces. It is **not a medical device**. It does not monitor breathing, does not prevent SIDS and must never be used on a real baby.

## What you see

| Screen | When | Sound |
|---|---|---|
| **All good** (green) | the board is not face down | off |
| **Flipped** (red) | the board has been face down for 3 s | beeps |
| after **Silence alarm** | still red, sound stops, beeps again if still flipped 30 s later | off, then on |
| **No signal** (orange) | no data from the sensor for 2 s | beeps |

Under the status, a drawing of the board tilts the same way the real one does, and a bar shows where it is between **Face up**, **On side** and **Face down**.

The page also keeps a flip history (when, for how long, silenced or not), which you can export as CSV. **Fast alert** shortens the 3 s wait to 1 s for demos.

## How it works

```text
 SENSOR BOARD                         LAPTOP (Chrome or Edge)
┌──────────────────────┐   USB     ┌────────────────────────────┐
│ MPU6050 → Arduino    │ ────────→ │ serial.js  reads the lines │
│ decides OK / FLIPPED │  5 lines  │ logic.js   alarm + history │
│                      │  per sec  │ app.js     screen + sound  │
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

3. **Sending it to the laptop.** Every 200 ms the board sends one text line over USB, for example `S,48210,FLIPPED,-0.97` (time in ms, state, z).

4. **The page.** It reads the lines with the Web Serial API and decides the screen, sound, silence and no-signal alarm. That logic is in plain functions in [web/logic.js](web/logic.js), tested in [tests/logic.test.js](tests/logic.test.js).

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

**Without hardware:** open the page, expand **No sensor? Use the simulator**, press **Start simulator**, then use **Face up / On side / Face down / Unplug**.

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
| Logic tests | `npm test` | 25 / 25 pass |

## Limitations

- Tested only by flipping the bare board by hand, never on a doll, in clothing or on a body.
- It only knows which way the board faces. It knows nothing about breathing, heart rate or health.
- The board needs a USB cable, and the laptop must stay awake with the page open.
- If the board turns inside a pocket, the reading is wrong.

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
