# RollWatch — Test Results

All tests were run **on a test doll**. Never on a real baby.
Position awareness only. Not a medical device.

> Not measured yet. Fill in from the shared Google Sheet after Phase 4.
> Do not change or round numbers in our favor.

Firmware: `fw=1`, FLIP_CONFIRM = 3 s (normal mode) unless noted.
IMU model: ________  Date: ________

## E1 — Flip detection

What we did: rolled the doll onto its stomach 20 times, waiting for OK in between.

| Trials | Alerts fired | Result |
|---|---|---|
| 20 | __ | __ / 20 |

## E2 — False alerts

What we did: doll on its back, 20 wiggles (lift and drop an arm, shake gently, tilt onto a side and back).

| Trials | Alerts fired (target 0) |
|---|---|
| 20 | __ |

## E3 — Alarm delay

What we did: 10 flips, stopwatch from flip to alarm.

| Trial | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Seconds | | | | | | | | | | |

Average: __ s  Max: __ s  Extra delay beyond the 3 s confirm: __ s

## E4 — Disconnect detection

What we did: unplugged the USB cable 5 times, timed until "POD DISCONNECTED".

| Trial | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Seconds | | | | | |

Average: __ s  Max: __ s

## E5 — Logic tests

`npm test`: __ passed / __ total

## Notes on bad trials

(Copy every note from the Sheet, e.g. "table bumped".)

## Limitations

- Tested on one doll, one onesie, one pod.
- Wired USB only; the pod is not sealed, washable or safe to leave near a baby.
- Stopwatch timings include human reaction time.
- Detects only chest-down vs chest-up; it does not monitor breathing or prevent SIDS.
