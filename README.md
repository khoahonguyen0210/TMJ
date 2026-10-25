# RollWatch

A wireless sensor pod in the chest pocket of a baby's onesie notices when the baby rolls onto their stomach. A small speaker on the pod sounds the alarm, the parent's phone buzzes with an **Acknowledge** button, and the parent can watch the crib and talk to the baby from the phone. In the morning the night report shows what happened.

> **The pod senses, the base decides, the speaker and phone alert.**

No API keys or accounts needed: everything runs in the browser.

So far we have tested the electronics and the page by **flipping the pod by hand**. The doll-in-a-onesie test is the next step.

> **Safety.** RollWatch is a hackathon prototype that only knows which way the pod faces. It is **not a medical device**. It does not monitor breathing, does not prevent SIDS and must never be used on a real baby.

## The three parts

| Part | What it is | Job |
|---|---|---|
| **Pod** (on the baby) | ESP32-S3 + MPU6050 motion sensor + amplifier + speaker + small power bank | decides OK / FLIPPED, sends it over **Bluetooth**, plays the alarm the base asks for. No cable on the baby. |
| **Base** (by the crib) | a laptop with this web page open in Chrome | receives the pod, runs every alarm, the log, the report, live view and the phone pushes |
| **Parent's phone** | the free **ntfy** app, plus the RollWatch parent page | lock-screen alarm with an Acknowledge button; live view and **talk to the baby** |

In a real product the base would be a small box; in the prototype it is a laptop.

## What you see

| Screen | When | Sound |
|---|---|---|
| **All good** (green) | the pod is not face down | off |
| **On side** (yellow) | lying on its side for 3 s, not an alarm | one soft beep |
| **Likely to roll** (yellow) | on its side and moving for 2 s (a simple rule, not AI) | one soft beep |
| **Flipped** (red) | face down for 3 s | alarm |
| after **Silence alarm** | still red, sound stops, alarms again if still flipped 30 s later | off, then on |
| **Pod disconnected** (orange) | no data from the pod for 2 s | alarm |

Under the status, a drawing of the pod tilts the same way the real one does, and a bar shows where it is between **Face up**, **On side** and **Face down**. **Fast alert** shortens the 3 s wait to 1 s for demos.

### When nobody answers

- **Gets louder:** an alarm nobody silences gets louder and faster after 30 s (and the phone buzzes again). After 60 s it goes to maximum and a **NO RESPONSE** banner appears. Silence resets it.
- **Flashes the screen:** during an alarm the whole screen pulses red once a second (never faster, which keeps it safe for people sensitive to flashing). It can be switched off under **Flash the screen**.
- **Reconnects by itself:** if the pod drops (power bank off, out of range, cable pulled on USB backup), the page alarms **Pod disconnected** and retries every 2 s. It never shows "All good" until real data comes back.

### Speaker

**Alarm output** chooses where the alarm plays:

- **Speaker on the pod** (default): an amplifier and speaker wired to the pod's ESP32. The laptop sends the commands over Bluetooth. If the pod hears nothing from the laptop for 12 s while it is face down, it beeps on its own.
- **Laptop**, or **Pod + laptop**.

If the pod drops, the laptop plays the alarm anyway. **Test** next to Pod plays three short beeps.

| Base sends | Speaker plays |
|---|---|
| `A,0` | silent |
| `A,1` | alarm level 1: 1000 Hz, 200 ms on / 800 ms off |
| `A,2` | level 2: 1500 Hz, 200 ms on / 300 ms off |
| `A,3` | level 3: 1000 / 1500 Hz alternating, continuous |
| `W,1` | one soft warning beep (rolled onto a side) |
| `T,1` | test: three short beeps |

### Live view and talk to the baby

On the laptop, press **Start live view** (pick a camera first if there are several). A QR code appears. Scan it with the iPhone camera: the **parent page** opens. Tap **Watch** to see and hear the crib, and **hold Talk** to speak; your voice plays from the laptop's speakers (the pod's speaker can only beep). Alarm notifications also open this page while live view is on.

- Live only: nothing is recorded or stored.
- Uses WebRTC through PeerJS (free public server for connecting; the video and sound go phone ↔ laptop directly when the network allows).
- The phone needs the page on **https** for its microphone, so open it from the GitHub Pages link (the QR code points there).
- Voice never touches the alarms.

### Phone notifications

The page sends alarms to a phone through [ntfy](https://ntfy.sh). There is no app to build: install the free **ntfy** app, then on the page open **Phone notifications**, press **New** to get a random topic, subscribe to that topic in the app, and switch **Send notifications** on.

| What happened | Phone gets | Priority |
|---|---|---|
| Flipped | "Baby rolled onto stomach" + **Acknowledge** button | high |
| No answer for 30 s / 60 s | "Still on stomach – no response 30 s" / "NO RESPONSE – 60 s" + Acknowledge | urgent |
| Pod disconnected | "Monitor offline" + Acknowledge | high |
| Silenced (laptop or phone) | "Acknowledged from phone after 12 s" | low |
| Back face up | "Back on back after 1 min 20 s" | low |
| Reconnected | "Monitor reconnected" | low |
| On side / likely to roll | nothing, to avoid spam | – |

- **Acknowledge on the phone** silences the pod and the laptop, and the night log records where it was silenced from and how long it took.
- A failed push shows a message on the page and never delays the alarm. Pushes from the simulator start with `[Simulator]`.
- Anyone who knows the topic can read it, so pick a random one and keep it to yourself. Messages carry no names or personal data.

### Night report

Everything from Connect until **End night** (or closing the page) is one night. It is saved in the browser and shows:

- a timeline of the night (not flipped / on side / flipped / pod disconnected)
- flips, longest flip, total time face down, average time until someone pressed Silence
- early warnings, and how many were followed by a flip within 60 s
- flips per hour (chart)
- every event, exportable as CSV

**Print report** makes a one-page morning report (timeline, stats, chart, events and the safety note). Choose "Save as PDF" in the print dialog to share it.

Pick an older night from the list to look back. **Sample night** is made-up data for trying the report without hardware; it and any night recorded with the simulator are labeled **Simulated demo data**.

### Trends

Once you have saved 2 or more nights, **Trends** shows each night's flips, longest flip, average time to silence and restless minutes, with the change from the night before. Simulated nights are left out unless you tick the box.

### Activity model

A small k-nearest-neighbours model (k = 5, plain JavaScript) trained on our own labeled recordings. It sorts every 2 seconds into **Still**, **Restless** or **Carried** and shows a row under the night timeline. **It never changes the alarms**; those stay rule-based.

- Features per 2 s window: mean z, mean x, mean motion, max motion, z range.
- Training data: hold **Still / Restless / Carried** in Label mode while moving the real pod, about 2 minutes each, in 2 separate sessions. Export to `web/model/activity-data.json`.
- Evaluation: train on session 1, test on session 2, then swap, compared with a simple rule (motion > 0.05 → restless). `npm run eval-activity` prints accuracy and confusion tables from the real data.

## How it works

```text
 POD (ESP32-S3 + IMU + amp + speaker, power bank)
        │ ↑ Bluetooth (BLE, Nordic UART Service): lines up, alarm commands down
        ↓ │
 BASE (laptop, Chrome)
   ble.js       pod lines
   logic.js     alarms, side rule, escalation, speaker commands
   analytics.js night stats         live.js    live view + talk-back
   notify.js    phone (ntfy) ──→ ntfy.sh ──→ parent's phone
                                     ←── Acknowledge (ack topic)
```

1. **Which way is it facing?** The MPU6050 measures how much of gravity points out of the chip's face. We call that number **z**:

   | Pod | z |
   |---|---|
   | chip facing out (on back) | about +1 |
   | on its side | about 0 |
   | chip facing in (on stomach) | about −1 |

   The page turns z into a tilt angle: 0° is face up, 90° is on its side, 180° is face down.

2. **When is it "flipped"?** The pod reads z 50 times a second and smooths it. If z stays below **−0.7** (tilted more than about 134°) for 3 s, it is **FLIPPED**. It goes back to **OK** only when z rises above **+0.7** (less than about 46°). Lying on a side keeps whatever state it was in, so tipping over sideways never sets off the alarm.

3. **Sending it to the laptop.** Every 200 ms the pod sends one text line, for example `S,48210,OK,0.03,0.98,0.07`: time in ms, state, z, then **x** (about ±1 when on a side) and **motion** (how much it is being moved over the last second, 0 = still). Over Bluetooth each line goes in chunks of up to 20 bytes; the page joins them again. The USB backup pod sends the same lines over a cable.

4. **On its side?** The page shows **On side** when |x| stays above **0.7** for 3 s, and **Likely to roll** when it is on its side and motion stays above **0.05** for 2 s. Flipped always wins. `MOTION_T` (0.05) is a tuning value in [web/config.js](web/config.js).

5. **The base decides.** The pod only says OK / FLIPPED. The page decides alarms, escalation, silence, disconnects, logging and notifications, and tells the pod's speaker what to play. The rules are plain functions in [web/logic.js](web/logic.js) and [web/analytics.js](web/analytics.js), tested in [tests/](tests/).

## Hardware

**Pod**

| MPU6050 pin | ESP32-S3 pin |
|---|---|
| VCC | 3V3 (not 5V) |
| GND | GND |
| SDA | GPIO 8 |
| SCL | GPIO 9 |
| AD0 | GND (address 0x68) |

Power: a power bank into a USB-C port, in a separate pocket with a short cable up to the pod. Upload through the USB-C port labeled **COM**. Some power banks switch off when the current is very low; if the pod keeps turning off, try another one.

Our MPU6050 read about 0.48 too high on z, so the firmware subtracts that (`Z_OFFSET_G`). If you use a different chip, check it: z should read about +1 face up and −1 face down.

If the sensor sits at an angle, connect the pod, lay it face up and press **Set face up** on the page. The pod remembers that position as 0° (even after power off) and measures z and x from it.

**Speaker on the pod**

| From | To |
|---|---|
| ESP32 **GPIO 7** | amp input (through 10 kΩ) |
| ESP32 **5Vin** and **GND** | amp power + and − |
| Speaker red / black | amp speaker + / − |

If the amp's only input is a 3.5 mm jack, use a 3.5 mm cable cut open or a 3.5 mm breakout: GPIO 7 (through 10 kΩ) to the tip, GND to the sleeve.

## How to run it

**Start the page.** In the project folder:

```bash
npx serve .     # then open http://localhost:3000/web/ in Chrome or Edge
```

Bluetooth and USB only work in Chrome or Edge on a computer, on `localhost` or an `https://` page (not on an iPhone).

**Without hardware:** expand **No sensor? Use the simulator**, press **Start simulator**, then use **Face up / On side / Face down / Wiggle / Unplug**. Or pick **Sample night** in the Night report.

**Pod (Bluetooth):**

1. In the Arduino IDE pick the board **ESP32S3 Dev Module** and upload [firmware/i2c_scan/i2c_scan.ino](firmware/i2c_scan/i2c_scan.ino) through the **COM** port. The Serial Monitor should show `0x68`.
2. Upload [firmware/pod/pod.ino](firmware/pod/pod.ino). A Bluetooth scanner app such as nRF Connect should now see **RollWatch-Pod**.
3. Unplug it from the computer, plug in the power bank, and press **Connect pod (Bluetooth)** on the page. Pick RollWatch-Pod. This click also lets the browser play sound. Press **Test** next to Pod: the pod's speaker should beep three times.

**Pod (USB backup):** upload [firmware/pod-usb/pod-usb.ino](firmware/pod-usb/pod-usb.ino) to an Arduino Uno/Nano with the sensor on A4/A5, close the Serial Monitor, then press **USB backup** on the page. (The Bluetooth pod also prints its lines on USB, so it works here too.)

**Phone:** see [Phone notifications](#phone-notifications) and [Live view](#live-view-and-talk-to-the-baby). The parent page lives at `web/parent.html`; `PARENT_PAGE` in [web/config.js](web/config.js) is the address the QR code uses.

**Tests:**

```bash
npm test                # logic, analytics, model, notification and line-joining tests (Node.js 20+)
npm run eval-activity   # activity model results from web/model/activity-data.json
```

## Limitations

- Tested so far by flipping the pod by hand, not yet on a doll in a onesie, and never on a body.
- It only knows which way the pod faces. It knows nothing about breathing, heart rate or health.
- The laptop is the base: it must stay awake with the page open in Chrome or Edge, within Bluetooth range (a few metres).
- The pod runs on a separate power bank with a short cable; some power banks switch themselves off.
- If the pod turns inside the pocket, the reading is wrong.
- "Likely to roll" is a fixed rule (on its side + moving), not a trained model, and its threshold has not been tuned on real movement yet.
- The activity model is only as good as our own recordings, and has no results until those recordings exist.
- Phone notifications and live view only work while the laptop page is open and online. Live view may not connect on networks that block peer-to-peer traffic.

## What a real product would still need

- A dedicated base box instead of a laptop
- Sealed pod too large to swallow, with no loose parts
- Built-in rechargeable battery instead of a power bank
- Washable, skin-safe casing
- Its own phone app
- Testing on a moving body, safety testing and regulatory review

## Credits

Built at HowdyHack by a team of four:

- **SW-A**: pod firmware (Bluetooth and speaker), phone notifications
- **SW-B**: web page, Bluetooth connect, speaker commands, settings
- **HW-A**: pod wiring, power and speaker
- **HW-B**: onesie pockets, testing and demo station

All code was written with an AI assistant and reviewed, run and tested by the software members.

License: see [LICENSE](LICENSE).
